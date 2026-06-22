import { loadConfig, buildServiceUrl } from '@dokkimi/config';
import { trackEvent } from '@dokkimi/telemetry';
import { enterAltScreen, exitAltScreen } from '../lib/terminal';
import type { InstanceSummary } from '../lib/inspect-types';
import { buildRunMenuItems, fetchAllRuns, pickRun } from '../lib/run-picker';
import {
  buildWriteContext,
  cleanupReviewTempDir,
  loadPendingForRun,
  loadPendingFromLatestRun,
  type PendingItem,
} from './baselines-ops';
import { testListView, type FlowResult } from './baselines-views';

// ---------------------------------------------------------------------------
// Command entry
// ---------------------------------------------------------------------------

export async function baselines(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: dokkimi baselines [--run]');
    console.log('');
    console.log('Review and approve pending visual baselines.');
    console.log('');
    console.log('Options:');
    console.log(
      '  --run     Browse and select from run history instead of using the latest run',
    );
    process.exit(0);
  }

  if (!process.stdin.isTTY) {
    console.error('Interactive terminal required.');
    process.exit(1);
  }

  const config = loadConfig();
  const ctUrl = buildServiceUrl(config.services.controlTower);
  const useHistory = args.includes('--run');

  if (useHistory) {
    const allRuns = await fetchAllRuns(ctUrl);
    if (!allRuns) {
      console.log('No run history found. Run `dokkimi run` first.');
      return;
    }

    let menuItems = await buildRunMenuItems(ctUrl, allRuns);
    enterAltScreen();
    try {
      while (true) {
        const run = await pickRun(
          menuItems,
          'Select a run to review baselines:',
        );
        if (!run) {
          break;
        }
        const items = await loadPendingForRun(ctUrl, run.instances);
        if (items.length === 0) {
          process.stdout.write('\x1b[2J\x1b[H');
          process.stdout.write('No pending baselines in this run.\n\n');
          process.stdout.write('\x1b[90mPress any key to go back...\x1b[0m');
          await waitForAnyKey();
          continue;
        }
        const result = await reviewRun(items, ctUrl);
        process.stdout.write('\x1b[2J\x1b[H');
        printSummary(result);
        process.stdout.write('\n\x1b[90mPress any key to go back...\x1b[0m');
        await waitForAnyKey();
        menuItems = await buildRunMenuItems(ctUrl, allRuns);
      }
    } finally {
      exitAltScreen();
      cleanupReviewTempDir();
    }
    return;
  }

  const items = await loadPendingFromLatestRun(ctUrl);
  if (items.length === 0) {
    console.log('No pending baselines from the last run.');
    return;
  }

  enterAltScreen();
  let result: FlowResult;
  try {
    result = await reviewRun(items, ctUrl);
  } finally {
    exitAltScreen();
    cleanupReviewTempDir();
  }
  printSummary(result);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function reviewRun(
  items: PendingItem[],
  ctUrl: string,
): Promise<FlowResult> {
  const ctx = buildWriteContext(ctUrl);
  const initialPendingCount = items.length;
  const initialNewCount = items.filter(
    (i) => i.artifact.verdict === 'no-baseline',
  ).length;

  const result = await testListView(items, ctx);

  trackEvent('cli_baselines', {
    approved: result.approved,
    skipped: result.skipped,
    total_pending: initialPendingCount,
    new_count: initialNewCount,
    changed_count: initialPendingCount - initialNewCount,
    mode: 'interactive',
  });

  return result;
}

function printSummary(result: FlowResult): void {
  if (result.approved > 0 || result.skipped > 0) {
    const parts: string[] = [];
    if (result.approved > 0) {
      parts.push(`\x1b[32m${result.approved} approved\x1b[0m`);
    }
    if (result.skipped > 0) {
      parts.push(`\x1b[90m${result.skipped} skipped\x1b[0m`);
    }
    console.log(`\n${parts.join(', ')}`);
    if (result.approved > 0) {
      console.log(
        'Commit the updated baselines to git so they travel with the test definitions.',
      );
    }
  } else {
    console.log('\nNo baselines changed.');
  }
}

function waitForAnyKey(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', () => {
      resolve();
    });
  });
}

export type { InstanceSummary };
