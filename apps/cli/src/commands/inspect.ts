import { resolveDefinitions } from '@dokkimi/definition-resolver';
import { fetchJson } from '../lib/cli-utils';
import { loadConfig, buildServiceUrl } from '@dokkimi/config';
import { inspectRun } from '../lib/inspect-run';
import { selectMenu, MenuItem } from '../lib/menu';
import { enterAltScreen, exitAltScreen } from '../lib/terminal';
import type { LatestRunResponse } from '../lib/inspect-types';
import { getProjectPath, latestRunUrl } from '../lib/project-path';

function statusIcon(status: string): string {
  switch (status) {
    case 'COMPLETED':
      return '\x1b[32m✓\x1b[0m';
    case 'FAILED':
      return '\x1b[31m✗\x1b[0m';
    case 'CANCELLED':
      return '\x1b[33m○\x1b[0m';
    default:
      return '\x1b[90m·\x1b[0m';
  }
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  const time = d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24 && d.getDate() === now.getDate()) return `today ${time}`;
  if (diffDays < 2) return `yesterday ${time}`;
  if (diffDays < 7) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;

  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  }) + ` ${time}`;
}

function buildRunMenuItems(
  allRuns: LatestRunResponse[],
): MenuItem<LatestRunResponse>[] {
  const byProject = new Map<string, LatestRunResponse[]>();
  for (const run of allRuns) {
    const key = run.projectPath ?? '(no project)';
    if (!byProject.has(key)) {
      byProject.set(key, []);
    }
    byProject.get(key)!.push(run);
  }

  const items: MenuItem<LatestRunResponse>[] = [];
  let first = true;
  for (const [project, runs] of byProject) {
    if (!first) {
      items.push({ label: '', value: null as any, disabled: true });
    }
    first = false;
    items.push({
      label: `\x1b[1m${project}\x1b[0m`,
      value: null as any,
      disabled: true,
    });
    const timestamps = runs.map((r) => formatTimestamp(r.createdAt));
    const maxTsLen = Math.max(...timestamps.map((t) => t.length));
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      const icon = statusIcon(run.status);
      const instanceCount = run.instances.length;
      const label = `  ${icon} ${timestamps[i].padEnd(maxTsLen)}  ${run.status.padEnd(10)}  ${instanceCount} instance${instanceCount !== 1 ? 's' : ''}`;
      items.push({ label, value: run });
    }
  }
  return items;
}

export async function inspect(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: dokkimi inspect [path] [--run]');
    console.log('');
    console.log('Inspect test results and traffic logs from a run.');
    console.log('');
    console.log('Arguments:');
    console.log(
      '  [path]    Path to a specific definition file (.json, .yml, .yaml) or .dokkimi/ folder',
    );
    console.log('            Defaults to all definitions in the run');
    console.log('');
    console.log('Options:');
    console.log(
      '  --run     Browse and select from run history instead of using the latest run',
    );
    console.log('  --help, -h  Show this help message');
    process.exit(0);
  }

  const config = loadConfig();
  const ctUrl = buildServiceUrl(config.services.controlTower);
  const useHistory = args.includes('--run');
  const target = args.find((a) => !a.startsWith('-') && a !== '--run');

  if (useHistory) {
    const allRuns = await fetchJson<LatestRunResponse[]>(
      `${ctUrl}/runs/history?limit=50`,
    );
    if (!allRuns || allRuns.length === 0) {
      console.log('No run history found. Run `dokkimi run` first.');
      return;
    }

    const items = buildRunMenuItems(allRuns);
    enterAltScreen();
    try {
      while (true) {
        const picked = await selectMenu(items, 'Select a run to inspect:');
        if (!picked) {
          break;
        }

        let instances = picked.value.instances;
        if (target) {
          const result = resolveDefinitions(target);
          const names = new Set(result.definitions.map((d) => d.name));
          instances = instances.filter((i) => names.has(i.name));
        }

        if (instances.length === 0) {
          continue;
        }

        await inspectRun(ctUrl, picked.value.runId, instances, config.storage.dir, {
          manageAltScreen: false,
        });
        process.stdout.write('\x1b[2J\x1b[H');
      }
    } finally {
      exitAltScreen();
    }
    return;
  }

  const projectPath = getProjectPath();
  const run = await fetchJson<LatestRunResponse>(
    latestRunUrl(ctUrl, projectPath),
  );
  if (!run) {
    console.log('No run history found. Run `dokkimi run` first.');
    return;
  }

  let instances = run.instances;
  if (target) {
    const result = resolveDefinitions(target);
    const names = new Set(result.definitions.map((d) => d.name));
    instances = instances.filter((i) => names.has(i.name));
    if (instances.length === 0) {
      console.log(`No matching instances found for "${target}".`);
      return;
    }
  }

  await inspectRun(ctUrl, run.runId, instances, config.storage.dir);
}
