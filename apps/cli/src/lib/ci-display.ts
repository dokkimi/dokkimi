import { formatDuration } from './formatting';
import { fetchJson, sleep } from './cli-utils';
import type {
  RunStatusResponse,
  RunStatusInstance,
  RunOnceResult,
} from './run-display';
import type { AssertionResult, TestExecutionLog } from './inspect-types';

const POLL_INTERVAL_MS = 2000;

const TERMINAL_INSTANCE_STATUSES = new Set([
  'PASSED',
  'FAILED',
  'STOPPED',
  'COMPLETED',
  'SKIPPED',
]);

const TERMINAL_RUN_STATUSES = ['COMPLETED', 'FAILED'];

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
    printInstanceLine(inst, undefined, undefined);
    printedInstances.add(inst.id);
  }

  let latestStatus: RunStatusResponse | null = null;

  while (true) {
    if (abort?.signal.aborted) {
      return { passed: false, runId, instances: latestStatus?.instances ?? [] };
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
        for (const inst of result.instances) {
          if (inst.status !== 'PENDING' && !instanceStartedAt.has(inst.id)) {
            instanceStartedAt.set(inst.id, now);
          }
          const displayStatus = inst.testStatus ?? inst.status;
          if (
            TERMINAL_INSTANCE_STATUSES.has(displayStatus) &&
            !instanceCompletedAt.has(inst.id)
          ) {
            instanceCompletedAt.set(inst.id, now);
          }
        }
        latestStatus = result;

        for (const inst of result.instances) {
          const displayStatus = inst.testStatus ?? inst.status;
          if (
            TERMINAL_INSTANCE_STATUSES.has(displayStatus) &&
            !printedInstances.has(inst.id)
          ) {
            printedInstances.add(inst.id);
            printInstanceLine(
              inst,
              instanceStartedAt.get(inst.id),
              instanceCompletedAt.get(inst.id),
            );

            if (displayStatus === 'FAILED') {
              await printFailureDetails(ctUrl, inst);
            }
          }
        }

        if (TERMINAL_RUN_STATUSES.includes(result.status)) {
          const allInstances = [...result.instances, ...skipped];
          printSummaryCI(allInstances, Date.now() - runStart);
          const passed = result.status === 'COMPLETED';
          return { passed, runId, instances: allInstances };
        }
      }
    } catch {}

    await sleep(POLL_INTERVAL_MS);
  }
}

function printInstanceLine(
  inst: RunStatusInstance,
  startedAt: number | undefined,
  completedAt: number | undefined,
): void {
  const displayStatus = inst.testStatus ?? inst.status;
  let prefix: string;
  if (displayStatus === 'SKIPPED') {
    prefix = '\x1b[90m-\x1b[0m';
  } else if (displayStatus === 'PASSED' || displayStatus === 'COMPLETED') {
    prefix = '\x1b[32m✔\x1b[0m';
  } else {
    prefix = '\x1b[31m✘\x1b[0m';
  }

  let durationText = '';
  if (startedAt !== undefined && completedAt !== undefined) {
    durationText = `  \x1b[90m(${formatDuration(completedAt - startedAt)})\x1b[0m`;
  }

  const statusColor =
    displayStatus === 'PASSED' || displayStatus === 'COMPLETED'
      ? '\x1b[32m'
      : displayStatus === 'FAILED'
        ? '\x1b[31m'
        : '\x1b[90m';

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
}

function printStuckInstances(status: RunStatusResponse | null): void {
  if (!status) {
    return;
  }
  const stuck = status.instances.filter(
    (i) => !TERMINAL_INSTANCE_STATUSES.has(i.testStatus ?? i.status),
  );
  if (stuck.length === 0) {
    return;
  }
  console.log('');
  console.log('  Stuck instances:');
  for (const inst of stuck) {
    const displayStatus = inst.testStatus ?? inst.status;
    console.log(`    - ${inst.name}  (${displayStatus})`);
  }
}

function printSummaryCI(instances: RunStatusInstance[], totalMs: number): void {
  const passed = instances.filter((i) => {
    const s = i.testStatus ?? i.status;
    return s === 'PASSED' || s === 'COMPLETED';
  }).length;
  const failed = instances.filter(
    (i) => (i.testStatus ?? i.status) === 'FAILED',
  ).length;
  const skipped = instances.filter(
    (i) => (i.testStatus ?? i.status) === 'SKIPPED',
  ).length;
  const ran = instances.length - skipped;

  console.log('');
  if (failed === 0) {
    console.log(
      `[Dokkimi] \x1b[32m${passed} passed\x1b[0m  \x1b[90m(${formatDuration(totalMs)})\x1b[0m`,
    );
  } else {
    const failedNames = instances
      .filter((i) => (i.testStatus ?? i.status) === 'FAILED')
      .map((i) => i.name);
    console.log(
      `[Dokkimi] \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m of ${ran}  \x1b[90m(${formatDuration(totalMs)})\x1b[0m`,
    );
    console.log(`[Dokkimi] Failed: ${failedNames.join(', ')}`);
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
