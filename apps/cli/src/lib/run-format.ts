import { formatDuration, statusColor } from './formatting';
import type { RunStatusInstance, RunStatusResponse } from './run-display';
import { outcomeLabel, outcomeOf } from './outcome';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SPINNER_FRAMES = ['⣶', '⣧', '⣏', '⡟', '⠿', '⢻', '⣹', '⣼'];

// ---------------------------------------------------------------------------
// Instance categorization
// ---------------------------------------------------------------------------

export interface CategorizedInstances {
  inProgress: RunStatusInstance[];
  done: RunStatusInstance[];
  pendingCount: number;
  passedCount: number;
  failedCount: number;
}

export function categorizeInstances(
  runStatus: string,
  instances: RunStatusInstance[],
): CategorizedInstances {
  const inProgress: RunStatusInstance[] = [];
  const done: RunStatusInstance[] = [];
  let pendingCount = 0;
  let passedCount = 0;
  let failedCount = 0;

  for (const inst of instances) {
    const outcome = outcomeOf(runStatus, inst);
    if (outcome === 'running') {
      if (inst.status === 'PENDING') {
        pendingCount++;
      } else {
        inProgress.push(inst);
      }
      continue;
    }
    done.push(inst);
    if (outcome === 'passed') {
      passedCount++;
    } else {
      failedCount++;
    }
  }

  return { inProgress, done, pendingCount, passedCount, failedCount };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatInstanceLine(
  runStatus: string,
  inst: RunStatusInstance,
  startedAt: number | undefined,
  completedAt: number | undefined,
  spinner: string,
): string {
  const name = inst.name.padEnd(30);
  const outcome = outcomeOf(runStatus, inst);
  const displayStatus = outcomeLabel(runStatus, inst);
  const isTerminal = outcome !== 'running';
  const color = statusColor(displayStatus);

  let prefix: string;
  if (!isTerminal) {
    prefix = `\x1b[36m${spinner}\x1b[0m`;
  } else if (outcome === 'passed') {
    prefix = '\x1b[32m✔\x1b[0m';
  } else {
    prefix = '\x1b[31m✘\x1b[0m';
  }

  const status = `${color}${displayStatus.padEnd(12)}\x1b[0m`;

  let durationText: string;
  if (startedAt === undefined) {
    durationText = '';
  } else if (completedAt !== undefined) {
    durationText = `(${formatDuration(completedAt - startedAt)})`;
  } else if (!isTerminal) {
    durationText = `(${formatDuration(Date.now() - startedAt)})`;
  } else {
    durationText = '';
  }
  const duration = durationText ? `  \x1b[90m${durationText}\x1b[0m` : '';

  let error = '';
  if (inst.errorMessage) {
    const usedWidth =
      4 + 30 + 2 + 12 + (durationText ? 2 + durationText.length : 0) + 2;
    const termWidth = process.stdout.columns ?? 80;
    const available = termWidth - usedWidth;
    if (available > 10) {
      const oneLine = inst.errorMessage.replace(/\n/g, '  ');
      const msg =
        oneLine.length > available
          ? oneLine.slice(0, available - 1) + '…'
          : oneLine;
      error = `  \x1b[31m${msg}\x1b[0m`;
    }
  }

  return `  ${prefix} ${name}  ${status}${duration}${error}`;
}

export function printSummary(
  status: RunStatusResponse,
  totalMs: number,
  instanceStartedAt: Map<string, number>,
  instanceCompletedAt: Map<string, number>,
): void {
  console.log('');
  const instanceDurations: number[] = [];
  for (const inst of status.instances) {
    const started = instanceStartedAt.get(inst.id);
    const completed = instanceCompletedAt.get(inst.id);
    if (started !== undefined && completed !== undefined) {
      instanceDurations.push(completed - started);
    }
  }

  const statParts: string[] = [`total ${formatDuration(totalMs)}`];
  if (instanceDurations.length > 1) {
    statParts.push(
      `avg ${formatDuration(Math.round(instanceDurations.reduce((a, b) => a + b, 0) / instanceDurations.length))}`,
    );
  }
  const stats = `\x1b[90m(${statParts.join(', ')})\x1b[0m`;

  console.log(
    `${formatOutcomeCounts(status.status, status.instances)}  ${stats}`,
  );
  console.log('');
}

/**
 * "3 of 4 definitions passed: 1 not run". Before, a definition that didn't
 * pass but didn't fail (cancelled, never run, invalid) still read as passed.
 */
export function formatOutcomeCounts(
  runStatus: string,
  instances: RunStatusInstance[],
): string {
  const counts = new Map<string, number>();
  let passed = 0;
  for (const inst of instances) {
    const outcome = outcomeOf(runStatus, inst);
    if (outcome === 'passed') {
      passed++;
    } else {
      const label = outcomeLabel(runStatus, inst).toLowerCase();
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  const total = instances.length;
  const noun = `definition${total === 1 ? '' : 's'}`;
  if (passed === total) {
    return `\x1b[32m${total} of ${total} ${noun} passed.\x1b[0m`;
  }
  const rest = [...counts].map(([label, n]) => `${n} ${label}`).join(', ');
  const color = runStatus === 'CANCELLED' ? '\x1b[33m' : '\x1b[31m';
  const cancelled = runStatus === 'CANCELLED' ? 'Run cancelled. ' : '';
  return `${color}${cancelled}${passed} of ${total} ${noun} passed: ${rest}.\x1b[0m`;
}
