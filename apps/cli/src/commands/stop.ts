import { fetchPost, checkService } from '../lib/cli-utils';
import { loadConfig, buildServiceUrl } from '@dokkimi/config';

interface StopResult {
  runId?: string;
  status: string;
}

export async function stop(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: dokkimi stop [options]');
    console.log('');
    console.log(
      'Stop the current test run without cleaning up history or data.',
    );
    console.log('');
    console.log('Options:');
    console.log('  --json         Output results as JSON');
    console.log('  --help, -h     Show this help message');
    process.exit(0);
  }

  const jsonMode = args.includes('--json');
  const config = loadConfig();
  const ctUrl = buildServiceUrl(config.services.controlTower);

  const ctCheck = await checkService('Dokkimi', ctUrl);
  if (!ctCheck.healthy) {
    if (jsonMode) {
      console.log(JSON.stringify({ success: true, status: 'NOT_RUNNING' }));
      return;
    }
    console.log('Dokkimi is not running. Nothing to stop.');
    return;
  }

  try {
    const result = await fetchPost<StopResult>(`${ctUrl}/runs/stop`, {});

    if (jsonMode) {
      console.log(JSON.stringify({ success: true, ...result }));
      return;
    }

    if (result?.status === 'NO_ACTIVE_RUN') {
      console.log('No active run to stop.');
    } else {
      console.log('Run stopped.');
    }
  } catch (err) {
    if (jsonMode) {
      console.log(
        JSON.stringify({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return;
    }
    console.error(
      `Failed to stop run: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}
