import { resolveDefinitions } from '@dokkimi/definition-resolver';
import { fetchJson } from '../lib/cli-utils';
import { loadConfig, buildServiceUrl } from '@dokkimi/config';
import { inspectRun } from '../lib/inspect-run';
import { enterAltScreen, exitAltScreen } from '../lib/terminal';
import type { LatestRunResponse } from '../lib/inspect-types';
import { getProjectPath, latestRunUrl } from '../lib/project-path';
import { buildRunMenuItems, fetchAllRuns, pickRun } from '../lib/run-picker';

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
    const allRuns = await fetchAllRuns(ctUrl);
    if (!allRuns) {
      console.log('No run history found. Run `dokkimi run` first.');
      return;
    }

    const items = buildRunMenuItems(allRuns);
    enterAltScreen();
    try {
      while (true) {
        const run = await pickRun(items, 'Select a run to inspect:');
        if (!run) {
          break;
        }

        let instances = run.instances;
        if (target) {
          const result = resolveDefinitions(target);
          const names = new Set(result.definitions.map((d) => d.name));
          instances = instances.filter((i) => names.has(i.name));
        }

        if (instances.length === 0) {
          continue;
        }

        await inspectRun(ctUrl, run.runId, instances, config.storage.dir, {
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
