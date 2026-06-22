import { selectMenu } from '../lib/menu';
import { exitAltScreen } from '../lib/terminal';
import type { PendingItem, WriteContext } from './baselines-ops';
import {
  approveAll,
  groupByTest,
  openImages,
  updateVerdict,
  writeBaseline,
} from './baselines-ops';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FlowResult {
  approved: number;
  skipped: number;
}

type DetailResult = 'approved' | 'skipped' | 'back';
type DetailAction = 'approve' | 'skip' | 'open' | 'back';

// ---------------------------------------------------------------------------
// View 1 — Test list
// ---------------------------------------------------------------------------

export async function testListView(
  items: PendingItem[],
  ctx: WriteContext,
): Promise<FlowResult> {
  let approved = 0;
  let skipped = 0;

  while (true) {
    const grouped = groupByTest(items);
    if (grouped.length === 0) {
      break;
    }

    const menuItems = grouped.map(({ testName, items: testItems }) => {
      const newCount = testItems.filter(
        (i) => i.artifact.verdict === 'no-baseline',
      ).length;
      const changedCount = testItems.length - newCount;

      const parts: string[] = [];
      if (newCount > 0) {
        parts.push(`${newCount} new`);
      }
      if (changedCount > 0) {
        parts.push(`${changedCount} changed`);
      }
      const summary = parts.join(', ');

      return {
        label: `${testName.padEnd(32)} \x1b[90m${summary}\x1b[0m`,
        value: { testName, items: testItems },
      };
    });

    const remaining = items.length;
    const title = `Pending baselines (${grouped.length} test${grouped.length === 1 ? '' : 's'}, ${remaining} remaining)`;

    process.stdout.write('\x1b[2J\x1b[H');
    const picked = await selectMenu(menuItems, title, {
      extraHint: 'A approve all',
      onKey: (key) => (key === 'A' ? 'approve-all' : null),
    });

    if (!picked) {
      break;
    }

    if (picked.action === 'approve-all') {
      const result = await approveAll(items, ctx);
      approved += result;
      items.length = 0;
      break;
    }

    const testItems = picked.value.items;
    const beforeCount = testItems.length;
    const result = await baselineListView(testItems, ctx);
    approved += result.approved;
    skipped += result.skipped;

    // Remove resolved items from the master list
    if (testItems.length < beforeCount) {
      const remaining = new Set(testItems);
      for (let i = items.length - 1; i >= 0; i--) {
        if (
          items[i].instanceName === picked.value.testName &&
          !remaining.has(items[i])
        ) {
          items.splice(i, 1);
        }
      }
    }
  }

  return { approved, skipped };
}

// ---------------------------------------------------------------------------
// View 2 — Baseline list within a test
// ---------------------------------------------------------------------------

async function baselineListView(
  items: PendingItem[],
  ctx: WriteContext,
): Promise<FlowResult> {
  let approved = 0;
  let skipped = 0;

  while (true) {
    if (items.length === 0) {
      break;
    }

    const menuItems = items.map((item) => {
      const verdict = item.artifact.verdict ?? 'no-baseline';
      const tag =
        verdict === 'no-baseline'
          ? '\x1b[33m[NEW]\x1b[0m     '
          : '\x1b[31m[CHANGED]\x1b[0m ';
      return {
        label: `${tag} ${(item.artifact.name ?? '(unnamed)').padEnd(28)}`,
        value: item,
      };
    });

    const testName = items[0].instanceName;
    const title = `${testName} (${items.length} baseline${items.length === 1 ? '' : 's'})`;

    process.stdout.write('\x1b[2J\x1b[H');
    const picked = await selectMenu(menuItems, title, {
      leftArrowBack: true,
      extraHint: 'A approve all',
      onKey: (key) => (key === 'A' ? 'approve-all' : null),
    });

    if (!picked) {
      break;
    }

    if (picked.action === 'approve-all') {
      const result = await approveAll(items, ctx);
      approved += result;
      items.length = 0;
      break;
    }

    const action = await detailView(picked.value, ctx);

    if (action === 'approved' || action === 'skipped') {
      items.splice(picked.index, 1);
      if (action === 'approved') {
        approved++;
      }
      if (action === 'skipped') {
        skipped++;
      }
    }
  }

  return { approved, skipped };
}

// ---------------------------------------------------------------------------
// View 3 — Detail view for a single baseline
// ---------------------------------------------------------------------------

async function detailView(
  item: PendingItem,
  ctx: WriteContext,
): Promise<DetailResult> {
  const verdict = item.artifact.verdict ?? 'no-baseline';
  const tag =
    verdict === 'no-baseline'
      ? '\x1b[33m[NEW]\x1b[0m'
      : '\x1b[31m[CHANGED]\x1b[0m';

  while (true) {
    process.stdout.write('\x1b[2J\x1b[H');
    process.stdout.write(`\x1b[1m${item.artifact.name}\x1b[0m  ${tag}\n\n`);

    const hints = [
      'y/a approve',
      's skip',
      '→/Enter/o open images',
      '←/ESC/q back',
    ];
    process.stdout.write(`\x1b[90m${hints.join('   ')}\x1b[0m\n`);

    const action = await waitForDetailAction();

    if (action === 'approve') {
      writeBaseline(ctx, item);
      await updateVerdict(ctx.ctUrl, item.artifact.id, 'approved');
      return 'approved';
    } else if (action === 'skip') {
      await updateVerdict(ctx.ctUrl, item.artifact.id, 'skipped');
      return 'skipped';
    } else if (action === 'open') {
      openImages(item, ctx);
    } else {
      return 'back';
    }
  }
}

function waitForDetailAction(): Promise<DetailAction> {
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    function cleanup() {
      process.stdin.removeListener('data', onKey);
    }

    function onKey(key: string) {
      if (key === 'y' || key === 'Y' || key === 'a' || key === 'A') {
        cleanup();
        resolve('approve');
      } else if (key === 's' || key === 'S') {
        cleanup();
        resolve('skip');
      } else if (
        key === 'o' ||
        key === 'O' ||
        key === '\r' ||
        key === '\n' ||
        key === '\x1b[C' ||
        key === '\x1bOC'
      ) {
        cleanup();
        resolve('open');
      } else if (
        key === '\x1b' ||
        key === 'q' ||
        key === '\x1b[D' ||
        key === '\x1bOD'
      ) {
        cleanup();
        resolve('back');
      } else if (key === '\x03') {
        cleanup();
        exitAltScreen();
        process.exit(0);
      }
    }

    process.stdin.on('data', onKey);
  });
}
