import { formatDuration } from './formatting';
import { enterAltScreen, exitAltScreen } from './terminal';
import { fetchJson, sleep } from './cli-utils';
import {
  TERMINAL_INSTANCE_STATUSES,
  SPINNER_FRAMES,
  categorizeInstances,
  formatInstanceLine,
  printSummary,
} from './run-format';

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

// ---------------------------------------------------------------------------
// Types shared across run modules
// ---------------------------------------------------------------------------

export interface RunStatusInstance {
  id: string;
  name: string;
  status: string;
  testStatus?: string;
  errorMessage?: string;
}

export interface RunStatusResponse {
  runId: string;
  status: string;
  instances: RunStatusInstance[];
}

export interface RunOnceResult {
  passed: boolean;
  runId: string | null;
  instances: RunStatusInstance[];
  hasUiSteps?: boolean;
  baselinesUploaded?: number;
  consumedFiles?: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 1000;
const RENDER_INTERVAL_MS = 100;
const TERMINAL_RUN_STATUSES = ['COMPLETED', 'FAILED'];

// ---------------------------------------------------------------------------
// Status polling
// ---------------------------------------------------------------------------

export async function pollForCompletion(
  ctUrl: string,
  runId: string,
  abort?: AbortController,
  skippedInstances?: RunStatusInstance[],
): Promise<RunOnceResult> {
  const runStart = Date.now();
  const instanceStartedAt = new Map<string, number>();
  const instanceCompletedAt = new Map<string, number>();
  let tick = 0;
  let latestStatus: RunStatusResponse | null = null;
  let polling = false;
  const skipped = skippedInstances ?? [];

  async function poll(): Promise<void> {
    if (polling) {
      return;
    }
    polling = true;
    try {
      const result = await fetchJson<RunStatusResponse>(
        `${ctUrl}/runs/${runId}/status`,
      );
      if (result) {
        const now = Date.now();
        for (const inst of result.instances) {
          // Track when each instance leaves PENDING (actually starts deploying)
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
      }
    } finally {
      polling = false;
    }
  }

  // Kick off initial poll immediately
  await poll();

  // Poll on a longer interval in the background
  const pollTimer = setInterval(() => {
    poll();
  }, POLL_INTERVAL_MS);

  // Use alternate screen buffer for live updates — no line counting needed
  const isTTY = process.stdout.isTTY;
  if (isTTY) {
    enterAltScreen();
  }

  try {
    // Render loop runs fast for smooth spinner + timer
    while (true) {
      if (abort?.signal.aborted) {
        if (isTTY) {
          exitAltScreen();
          process.stdout.write('\x1b[u\x1b[J');
        }

        const snapshot = latestStatus as RunStatusResponse | null;
        const allInstances = snapshot
          ? [...snapshot.instances, ...skipped]
          : [...skipped];
        if (allInstances.length > 0) {
          const spinner = SPINNER_FRAMES[tick % SPINNER_FRAMES.length];
          const lines = allInstances.map((inst) =>
            formatInstanceLine(
              inst,
              instanceStartedAt.get(inst.id),
              instanceCompletedAt.get(inst.id),
              spinner,
            ),
          );
          console.log(lines.join('\n'));
        }
        console.log('');
        console.log(
          `\x1b[33mStopped after ${formatDuration(Date.now() - runStart)}\x1b[0m`,
        );
        console.log('');
        return { passed: false, runId, instances: allInstances };
      }

      // latestStatus is mutated asynchronously by the poll timer
      const current = latestStatus as RunStatusResponse | null;
      if (current) {
        const allInstances = [...current.instances, ...skipped];
        const isComplete = TERMINAL_RUN_STATUSES.includes(current.status);
        const elapsed = formatDuration(Date.now() - runStart);
        const total = allInstances.length;
        const spinner = SPINNER_FRAMES[tick % SPINNER_FRAMES.length];

        if (isComplete) {
          // Exit alt screen, clear from saved cursor, re-save so next
          // clearRunOutput() knows where the final output starts.
          if (isTTY) {
            exitAltScreen();
            process.stdout.write('\x1b[u\x1b[J');
            process.stdout.write('\x1b[s');
          }

          const lines: string[] = [];
          for (const inst of allInstances) {
            lines.push(
              formatInstanceLine(
                inst,
                instanceStartedAt.get(inst.id),
                instanceCompletedAt.get(inst.id),
                spinner,
              ),
            );
          }
          console.log(lines.join('\n'));

          printSummary(
            { ...current, instances: allInstances },
            Date.now() - runStart,
            instanceStartedAt,
            instanceCompletedAt,
          );
          const passed = current.status === 'COMPLETED';
          return { passed, runId, instances: allInstances };
        }

        // Live render on alt screen — cursor home + clear, fits any size
        const termHeight = process.stdout.rows ?? 24;
        const termWidth = process.stdout.columns ?? 80;

        // Layout: header(1) + blank(1) + instances(?) + blank(1) + footer(1)
        const fixedLines = 4;
        const maxInstances = Math.max(0, termHeight - fixedLines);

        // Categorize
        const { inProgress, done, pendingCount, passedCount, failedCount } =
          categorizeInstances(allInstances);

        const buf: string[] = [];

        if (maxInstances <= 0) {
          // Tiny terminal — single line
          const parts = [
            `\x1b[1mRunning ${total}...\x1b[0m  \x1b[90m${elapsed}\x1b[0m`,
            passedCount > 0 ? `\x1b[32m${passedCount} passed\x1b[0m` : '',
            failedCount > 0 ? `\x1b[31m${failedCount} failed\x1b[0m` : '',
            inProgress.length > 0
              ? `\x1b[33m${inProgress.length} running\x1b[0m`
              : '',
            pendingCount > 0 ? `\x1b[90m${pendingCount} pending\x1b[0m` : '',
          ]
            .filter(Boolean)
            .join('  ');
          // Truncate to prevent wrapping
          const visibleLen = parts.replace(ANSI_RE, '').length;
          buf.push(
            visibleLen > termWidth
              ? `\x1b[1mRunning ${total}...\x1b[0m  \x1b[90m${elapsed}\x1b[0m`
              : parts,
          );
        } else {
          buf.push(
            `\x1b[1mRunning ${total} definition${total === 1 ? '' : 's'}...  \x1b[90m${elapsed}\x1b[0m`,
          );
          buf.push('');

          // Show in-progress first, then completed, clamped to fit
          const visible = [...inProgress, ...done];
          const needsSummary =
            visible.length > maxInstances || pendingCount > 0;
          const instanceSlots = needsSummary
            ? Math.max(0, maxInstances - 1)
            : maxInstances;
          const shown = visible.slice(0, instanceSlots);

          for (const inst of shown) {
            buf.push(
              formatInstanceLine(
                inst,
                instanceStartedAt.get(inst.id),
                instanceCompletedAt.get(inst.id),
                spinner,
              ),
            );
          }

          // Summary for anything not shown
          const summaryParts: string[] = [];
          const hiddenDone =
            done.length -
            Math.min(
              done.length,
              Math.max(0, instanceSlots - inProgress.length),
            );
          if (passedCount > 0 && hiddenDone > 0) {
            summaryParts.push(`\x1b[32m${passedCount} passed\x1b[0m`);
          }
          if (failedCount > 0 && hiddenDone > 0) {
            summaryParts.push(`\x1b[31m${failedCount} failed\x1b[0m`);
          }
          const hiddenInProgress = Math.max(
            0,
            inProgress.length - instanceSlots,
          );
          if (hiddenInProgress > 0) {
            summaryParts.push(`${hiddenInProgress} running`);
          }
          if (pendingCount > 0) {
            summaryParts.push(`${pendingCount} pending`);
          }
          if (summaryParts.length > 0) {
            buf.push(`  \x1b[90m${summaryParts.join('  ·  ')}\x1b[0m`);
          }

          buf.push('');
          buf.push(`\x1b[90mPress q/Ctrl+C to stop\x1b[0m`);
        }

        // Write entire frame at once: cursor home, lines with clear-to-EOL, clear rest.
        // Skip the trailing \n on the last line to avoid scrolling when buf fills the screen.
        process.stdout.write('\x1b[H');
        for (let i = 0; i < buf.length; i++) {
          const eol = i < buf.length - 1 ? '\n' : '';
          process.stdout.write(`\x1b[K${buf[i]}${eol}`);
        }
        process.stdout.write('\x1b[J');
      }

      tick++;
      await sleep(RENDER_INTERVAL_MS);
    }
  } finally {
    clearInterval(pollTimer);
    if (isTTY) {
      exitAltScreen();
    }
  }
}
