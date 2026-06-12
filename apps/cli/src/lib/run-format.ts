import { formatDuration, statusColor } from './formatting';
import type { RunStatusInstance, RunStatusResponse } from './run-display';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TERMINAL_INSTANCE_STATUSES = new Set([
  'PASSED',
  'FAILED',
  'STOPPED',
  'COMPLETED',
  'SKIPPED',
]);

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
  instances: RunStatusInstance[],
): CategorizedInstances {
  const inProgress: RunStatusInstance[] = [];
  const done: RunStatusInstance[] = [];
  let pendingCount = 0;
  let passedCount = 0;
  let failedCount = 0;

  for (const inst of instances) {
    const ds = inst.testStatus ?? inst.status;
    if (ds === 'PENDING') {
      pendingCount++;
    } else if (TERMINAL_INSTANCE_STATUSES.has(ds)) {
      done.push(inst);
      if (ds === 'PASSED' || ds === 'COMPLETED') {
        passedCount++;
      } else if (ds === 'FAILED') {
        failedCount++;
      }
    } else {
      inProgress.push(inst);
    }
  }

  return { inProgress, done, pendingCount, passedCount, failedCount };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatInstanceLine(
  inst: RunStatusInstance,
  startedAt: number | undefined,
  completedAt: number | undefined,
  spinner: string,
): string {
  const name = inst.name.padEnd(30);
  const displayStatus = inst.testStatus ?? inst.status;
  const isTerminal = TERMINAL_INSTANCE_STATUSES.has(displayStatus);
  const color = statusColor(displayStatus);

  let prefix: string;
  if (displayStatus === 'SKIPPED') {
    prefix = '\x1b[90m–\x1b[0m';
  } else if (!isTerminal) {
    prefix = `\x1b[36m${spinner}\x1b[0m`;
  } else if (displayStatus === 'PASSED' || displayStatus === 'COMPLETED') {
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
  const skippedCount = status.instances.filter(
    (i) => (i.testStatus ?? i.status) === 'SKIPPED',
  ).length;
  const ran = status.instances.length - skippedCount;
  const failed = status.instances.filter(
    (i) => (i.testStatus ?? i.status) === 'FAILED',
  ).length;
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
  if (skippedCount > 0) {
    statParts.push(`${skippedCount} skipped`);
  }
  const stats = `\x1b[90m(${statParts.join(', ')})\x1b[0m`;

  if (status.status === 'CANCELLED') {
    console.log(`\x1b[33mRun cancelled.\x1b[0m  ${stats}`);
  } else if (failed === 0) {
    console.log(
      `\x1b[32m${ran} of ${ran} definition${ran === 1 ? '' : 's'} passed.\x1b[0m  ${stats}`,
    );
  } else {
    console.log(
      `\x1b[31m${failed} of ${ran} definition${ran === 1 ? '' : 's'} failed.\x1b[0m  ${stats}`,
    );
  }
  console.log('');
}
