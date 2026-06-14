import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fetchJson, resolveUri } from '../lib/cli-utils';
import { loadConfig, buildServiceUrl } from '@dokkimi/config';
import { trackEvent } from '@dokkimi/telemetry';
import { resolveDefinitions } from '@dokkimi/definition-resolver';
import { findBaselinesDir } from '../lib/baseline-upload';
import { selectMenu } from '../lib/menu';
import { enterAltScreen, exitAltScreen } from '../lib/terminal';
import { openFile } from '../lib/editor';
import type {
  LatestRunResponse,
  ArtifactRow,
  InstanceSummary,
} from '../lib/inspect-types';
import { getProjectPath, latestRunUrl } from '../lib/project-path';
import { buildRunMenuItems, fetchAllRuns, pickRun } from '../lib/run-picker';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingResponse {
  pending: ArtifactRow[];
}

interface PendingItem {
  instanceId: string;
  instanceName: string;
  artifact: ArtifactRow;
}

interface WriteContext {
  sourceByName: Map<string, string>;
  storageDir: string;
  ctUrl: string;
}

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

    const menuItems = await buildRunMenuItems(ctUrl, allRuns);
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
        printSummary(result);
        process.stdout.write('\x1b[2J\x1b[H');
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

// ---------------------------------------------------------------------------
// View 1 — Test list
// ---------------------------------------------------------------------------

interface FlowResult {
  approved: number;
  skipped: number;
}

async function testListView(
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

type DetailResult = 'approved' | 'skipped' | 'back';

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

type DetailAction = 'approve' | 'skip' | 'open' | 'back';

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

// ---------------------------------------------------------------------------
// Approve all
// ---------------------------------------------------------------------------

async function approveAll(
  items: PendingItem[],
  ctx: WriteContext,
): Promise<number> {
  let count = 0;
  for (const item of items) {
    writeBaseline(ctx, item);
    await updateVerdict(ctx.ctUrl, item.artifact.id, 'approved');
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Open images
// ---------------------------------------------------------------------------

function openImages(item: PendingItem, ctx: WriteContext): void {
  const capturePath = resolveUri(item.artifact.uri, ctx.storageDir);
  const name = item.artifact.name ?? 'capture';
  const itemDir = path.join(reviewTempDir(), item.instanceId);
  fs.mkdirSync(itemDir, { recursive: true });

  if (item.artifact.verdict === 'fail') {
    const sourceFile = ctx.sourceByName.get(item.instanceName);
    if (sourceFile) {
      const baselinesDir = findBaselinesDir(sourceFile);
      if (baselinesDir) {
        const baselinePath = path.join(
          baselinesDir,
          `${item.artifact.name}.png`,
        );
        if (fs.existsSync(baselinePath)) {
          const namedPath = path.join(itemDir, `${name}--current.png`);
          fs.copyFileSync(baselinePath, namedPath);
          openFile(namedPath);
        }
      }
    }
  }

  if (fs.existsSync(capturePath)) {
    const label = item.artifact.verdict === 'fail' ? 'incoming' : 'new';
    const namedPath = path.join(itemDir, `${name}--${label}.png`);
    fs.copyFileSync(capturePath, namedPath);
    openFile(namedPath);
  }
}

// ---------------------------------------------------------------------------
// Write baseline to disk
// ---------------------------------------------------------------------------

function buildWriteContext(ctUrl: string): WriteContext {
  const result = resolveDefinitions();
  const sourceByName = new Map<string, string>();
  for (const def of result.definitions) {
    sourceByName.set(def.name, def.sourceFile);
  }
  const config = loadConfig();
  return { sourceByName, storageDir: config.storage.dir, ctUrl };
}

function writeBaseline(ctx: WriteContext, item: PendingItem): boolean {
  const sourceFile = ctx.sourceByName.get(item.instanceName);
  if (!sourceFile) {
    return false;
  }

  const baselinesDir =
    findBaselinesDir(sourceFile) ?? createBaselinesDir(sourceFile);
  const destPath = path.join(baselinesDir, `${item.artifact.name}.png`);
  const captureAbsPath = resolveUri(item.artifact.uri, ctx.storageDir);

  try {
    fs.mkdirSync(baselinesDir, { recursive: true });
    fs.copyFileSync(captureAbsPath, destPath);
    return true;
  } catch {
    return false;
  }
}

function createBaselinesDir(sourceFile: string): string {
  const projectRoot = path.dirname(path.dirname(sourceFile));
  return path.join(projectRoot, 'baselines');
}

// ---------------------------------------------------------------------------
// Update verdict via CT API
// ---------------------------------------------------------------------------

async function updateVerdict(
  ctUrl: string,
  artifactId: string,
  verdict: string,
): Promise<void> {
  try {
    await fetch(`${ctUrl}/artifacts/${artifactId}/verdict`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verdict }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Best-effort — don't block the UI if CT is slow
  }
}

// ---------------------------------------------------------------------------
// Group helpers
// ---------------------------------------------------------------------------

function groupByTest(
  items: PendingItem[],
): Array<{ testName: string; items: PendingItem[] }> {
  const map = new Map<string, PendingItem[]>();
  for (const item of items) {
    const bucket = map.get(item.instanceName) ?? [];
    bucket.push(item);
    map.set(item.instanceName, bucket);
  }
  return [...map.entries()].map(([testName, testItems]) => ({
    testName,
    items: testItems,
  }));
}

// ---------------------------------------------------------------------------
// Review temp dir
// ---------------------------------------------------------------------------

function reviewTempDir(): string {
  const dir = path.join(os.tmpdir(), 'dokkimi-baselines-review');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupReviewTempDir(): void {
  try {
    fs.rmSync(path.join(os.tmpdir(), 'dokkimi-baselines-review'), {
      recursive: true,
      force: true,
    });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Load pending from CT
// ---------------------------------------------------------------------------

async function loadPendingFromLatestRun(ctUrl: string): Promise<PendingItem[]> {
  const projectPath = getProjectPath();
  const latest = await fetchJson<LatestRunResponse>(
    latestRunUrl(ctUrl, projectPath),
  );
  if (!latest) {
    console.error('No run history found. Run `dokkimi run` first.');
    process.exit(1);
  }
  return loadPendingForRun(ctUrl, latest.instances);
}

async function loadPendingForRun(
  ctUrl: string,
  instances: InstanceSummary[],
): Promise<PendingItem[]> {
  const items: PendingItem[] = [];
  for (const inst of instances) {
    const res = await fetchJson<PendingResponse>(
      `${ctUrl}/artifacts/instance/${inst.id}/baselines-pending`,
    );
    for (const a of res?.pending ?? []) {
      items.push({ instanceId: inst.id, instanceName: inst.name, artifact: a });
    }
  }
  return items;
}

export type { InstanceSummary };
