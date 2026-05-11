import { resolveDefinitions } from '@dokkimi/definition-resolver';
import { fetchJson } from '../lib/cli-utils';
import { loadConfig, buildServiceUrl } from '@dokkimi/config';
import { inspectRun } from '../lib/inspect-run';
import type { LatestRunResponse } from '../lib/inspect-types';

export async function inspect(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: dokkimi inspect [path]');
    console.log('');
    console.log('Inspect test results and traffic logs from the last run.');
    console.log('');
    console.log('Arguments:');
    console.log(
      '  [path]    Path to a specific definition file (.json, .yml, .yaml) or .dokkimi/ folder',
    );
    console.log('            Defaults to all definitions in the last run');
    process.exit(0);
  }

  const config = loadConfig();
  const ctUrl = buildServiceUrl(config.services.controlTower);

  const latestRun = await fetchJson<LatestRunResponse>(`${ctUrl}/runs/latest`);
  if (!latestRun) {
    console.log('No run history found. Run `dokkimi run` first.');
    return;
  }

  let instances = latestRun.instances;
  const target = args.find((a) => !a.startsWith('-'));
  if (target) {
    const result = resolveDefinitions(target);
    const names = new Set(result.definitions.map((d) => d.name));
    instances = instances.filter((i) => names.has(i.name));
    if (instances.length === 0) {
      console.log(`No run history found for "${target}".`);
      return;
    }
  }

  await inspectRun(ctUrl, latestRun.runId, instances, config.storage.dir);
}
