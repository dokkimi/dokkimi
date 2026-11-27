import { formatDuration } from './formatting';
import { fetchJson, sleep, LOST_CONTACT_MS } from './cli-utils';
import type {
  RunStatusResponse,
  RunStatusInstance,
  RunOnceResult,
} from './run-display';
import type { AssertionResult, TestExecutionLog } from './inspect-types';
import { outcomeLabel, outcomeOf, runPassed } from './outcome';
import { formatOutcomeCounts } from './run-format';

const POLL_INTERVAL_MS = 2000;

const TERMINAL_RUN_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED'];

export async function pollForCompletionCI(
  ctUrl: string,
  runId: string,
  abort?: AbortController,
  skippedInstances?: RunStatusInstance[],
  timeoutMs?: number,
  totalDefinitions?: number,
): Promise<RunOnceResult> {
  const runStart = Date.now();
  const instanceStartedAt = new Map<string, number>();
  const instanceCompletedAt = new Map<string, number>();
  const printedInstances = new Set<string>();
  const skipped = skippedInstances ?? [];

  const total = totalDefinitions ?? 0;
  console.log(
    `[Dokkimi] Running ${total} definition${total === 1 ? '' : 's'}...`,
  );
  console.log('');

  for (const inst of skipped) {
    printInstanceLine('', inst, undefined, undefined);
    printedInstances.add(inst.id);
  }

  let latestStatus: RunStatusResponse | null = null;
  let lastAnswerAt = runStart;

  while (true) {
    if (abort?.signal.aborted) {
      return {
        passed: false,
        runId,
        runStatus: latestStatus?.status ?? '',
        instances: latestStatus?.instances ?? [],
      };
    }

    if (timeoutMs && Date.now() - runStart > timeoutMs) {
      console.log('');
      console.log(
        `[Dokkimi] \x1b[31mTimed out after ${formatDuration(timeoutMs)}\x1b[0m`,
      );
      printStuckInstances(latestStatus);
      return {
        passed: false,
        runId,
        runStatus: latestStatus?.status ?? '',
        instances: [
          ...(latestStatus?.instances ?? []),
          ...skipped.filter((s) => !printedInstances.has(s.id)),
        ],
      };
    }

    // Before, a run whose Dokkimi died was polled until the timeout
    if (Date.now() - lastAnswerAt > LOST_CONTACT_MS) {
      console.log('');
      console.log(
        `[Dokkimi] \x1b[31mLost contact with Dokkimi: no answer for ${LOST_CONTACT_MS / 1000}s\x1b[0m`,
      );
      printStuckInstances(latestStatus);
      return {
        passed: false,
        runId,
        runStatus: latestStatus?.status ?? '',
        instances: [
          ...(latestStatus?.instances ?? []),
          ...skipped.filter((s) => !printedInstances.has(s.id)),
        ],
      };
    }

    try {
      const result = await fetchJson<RunStatusResponse>(
        `${ctUrl}/runs/${runId}/status`,
      );
      if (result) {
        const now = Date.now();
        lastAnswerAt = now;
        for (const inst of result.instances) {
          if (inst.status !== 'PENDING' && !instanceStartedAt.has(inst.id)) {
            instanceStartedAt.set(inst.id, now);
          }
          if (
            outcomeOf(result.status, inst) !== 'running' &&
            !instanceCompletedAt.has(inst.id)
          ) {
            instanceCompletedAt.set(inst.id, now);
          }
        }
        latestStatus = result;

        for (const inst of result.instances) {
          const outcome = outcomeOf(result.status, inst);
          if (outcome !== 'running' && !printedInstances.has(inst.id)) {
            printedInstances.add(inst.id);
            printInstanceLine(
              result.status,
              inst,
              instanceStartedAt.get(inst.id),
              instanceCompletedAt.get(inst.id),
            );

            if (outcome === 'failed') {
              await printFailureDetails(ctUrl, inst);
            }
          }
        }

        if (TERMINAL_RUN_STATUSES.includes(result.status)) {
          const allInstances = [...result.instances, ...skipped];
          printSummaryCI(result.status, allInstances, Date.now() - runStart);
          return {
            passed: runPassed(result.status, allInstances),
            runId,
            runStatus: result.status,
            instances: allInstances,
          };
        }
      }
    } catch {}

    await sleep(POLL_INTERVAL_MS);
  }
}

function printInstanceLine(
  runStatus: string,
  inst: RunStatusInstance,
  startedAt: number | undefined,
  completedAt: number | undefined,
): void {
  const passed = outcomeOf(runStatus, inst) === 'passed';
  const displayStatus = outcomeLabel(runStatus, inst);
  const prefix = passed ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m';

  let durationText = '';
  if (startedAt !== undefined && completedAt !== undefined) {
    durationText = `  \x1b[90m(${formatDuration(completedAt - startedAt)})\x1b[0m`;
  }

  const statusColor = passed ? '\x1b[32m' : '\x1b[31m';

  console.log(
    `[Dokkimi] ${prefix} ${inst.name}  ${statusColor}${displayStatus}\x1b[0m${durationText}`,
  );
}

async function printFailureDetails(
  ctUrl: string,
  inst: RunStatusInstance,
): Promise<void> {
  if (inst.errorMessage) {
    console.log(`           \x1b[31m${inst.errorMessage}\x1b[0m`);
  }

  try {
    const [assertions, execLogs] = await Promise.all([
      fetchJson<AssertionResult[]>(
        `${ctUrl}/logs/assertion-results/instance/${inst.id}`,
      ),
      fetchJson<{ logs: TestExecutionLog[]; total: number }>(
        `${ctUrl}/logs/test-execution/instance/${inst.id}`,
      ),
    ]);

    const failedAssertions = (assertions ?? []).filter(
      (a) => !a.passed && a.assertionType !== 'skip',
    );
    const errorLogs = (execLogs?.logs ?? []).filter(
      (l) => l.eventType === 'step_error' || l.error,
    );

    if (failedAssertions.length > 0) {
      for (const a of failedAssertions) {
        const loc = a.path ? ` at ${a.path}` : '';
        const op = a.operator ?? 'equals';
        console.log(
          `           \x1b[31m✘\x1b[0m ${a.assertionType}${loc}  \x1b[90m(${op})\x1b[0m`,
        );
        console.log(
          `             expected: \x1b[32m${formatValue(a.expected)}\x1b[0m`,
        );
        console.log(
          `             received: \x1b[31m${formatValue(a.actual)}\x1b[0m`,
        );
      }
    } else if (errorLogs.length > 0) {
      for (const log of errorLogs.slice(0, 5)) {
        const msg = log.error ?? log.message;
        console.log(`           \x1b[31m${msg}\x1b[0m`);
      }
    }
  } catch {
    console.log(`           \x1b[90m(could not fetch failure details)\x1b[0m`);
  }
}

function printStuckInstances(status: RunStatusResponse | null): void {
  if (!status) {
    return;
  }
  const stuck = status.instances.filter(
    (i) => outcomeOf(status.status, i) === 'running',
  );
  if (stuck.length === 0) {
    return;
  }
  console.log('');
  console.log('  Stuck instances:');
  for (const inst of stuck) {
    console.log(`    - ${inst.name}  (${inst.status})`);
  }
}

function printSummaryCI(
  runStatus: string,
  instances: RunStatusInstance[],
  totalMs: number,
): void {
  console.log('');
  console.log(
    `[Dokkimi] ${formatOutcomeCounts(runStatus, instances)}  \x1b[90m(${formatDuration(totalMs)})\x1b[0m`,
  );
  const notPassed = instances.filter(
    (i) => outcomeOf(runStatus, i) !== 'passed',
  );
  if (notPassed.length > 0) {
    console.log(
      `[Dokkimi] Not passed: ${notPassed.map((i) => i.name).join(', ')}`,
    );
  }
  console.log('');
}

function formatValue(val: unknown): string {
  if (val === null || val === undefined) {
    return String(val);
  }
  if (typeof val === 'string') {
    return val.length > 100 ? val.slice(0, 100) + '…' : val;
  }
  const s = JSON.stringify(val);
  return s.length > 100 ? s.slice(0, 100) + '…' : s;
}
