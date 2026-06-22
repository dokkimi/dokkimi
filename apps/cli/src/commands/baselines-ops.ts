import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fetchJson, resolveUri } from '../lib/cli-utils';
import { loadConfig } from '@dokkimi/config';
import { resolveDefinitions } from '@dokkimi/definition-resolver';
import { findBaselinesDir } from '../lib/baseline-upload';
import { openFile } from '../lib/editor';
import type { ArtifactRow, InstanceSummary } from '../lib/inspect-types';
import { getProjectPath, latestRunUrl } from '../lib/project-path';
import type { LatestRunResponse } from '../lib/inspect-types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingResponse {
  pending: ArtifactRow[];
}

export interface PendingItem {
  instanceId: string;
  instanceName: string;
  artifact: ArtifactRow;
}

export interface WriteContext {
  sourceByName: Map<string, string>;
  storageDir: string;
  ctUrl: string;
}

// ---------------------------------------------------------------------------
// Approve all
// ---------------------------------------------------------------------------

export async function approveAll(
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

export function openImages(item: PendingItem, ctx: WriteContext): void {
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

export function buildWriteContext(ctUrl: string): WriteContext {
  const result = resolveDefinitions();
  const sourceByName = new Map<string, string>();
  for (const def of result.definitions) {
    sourceByName.set(def.name, def.sourceFile);
  }
  const config = loadConfig();
  return { sourceByName, storageDir: config.storage.dir, ctUrl };
}

export function writeBaseline(ctx: WriteContext, item: PendingItem): boolean {
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

export async function updateVerdict(
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

export function groupByTest(
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

export function reviewTempDir(): string {
  const dir = path.join(os.tmpdir(), 'dokkimi-baselines-review');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function cleanupReviewTempDir(): void {
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

export async function loadPendingFromLatestRun(
  ctUrl: string,
): Promise<PendingItem[]> {
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

export async function loadPendingForRun(
  ctUrl: string,
  instances: InstanceSummary[],
): Promise<PendingItem[]> {
  const items: PendingItem[] = [];
  for (const inst of instances) {
    const res = await fetchJson<PendingResponse>(
      `${ctUrl}/artifacts/instance/${inst.id}/baselines-pending`,
    );
    for (const a of res?.pending ?? []) {
      items.push({
        instanceId: inst.id,
        instanceName: inst.name,
        artifact: a,
      });
    }
  }
  return items;
}
