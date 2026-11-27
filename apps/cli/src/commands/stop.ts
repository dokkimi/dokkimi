import { fetchPostWithError, checkService } from '../lib/cli-utils';
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

  // Before, any failure (an error status, a timeout, no connection) read as
  // an empty result, and "Run stopped." was printed
  const result = await fetchPostWithError<StopResult>(`${ctUrl}/runs/stop`, {});
  if (result.error !== undefined) {
    if (jsonMode) {
      console.log(JSON.stringify({ success: false, error: result.error }));
    } else {
      console.error(`Failed to stop run: ${result.error}`);
    }
    process.exit(1);
  }

  if (jsonMode) {
    console.log(JSON.stringify({ success: true, ...result.data }));
    return;
  }
  console.log(
    result.data.status === 'NO_ACTIVE_RUN'
      ? 'No active run to stop.'
      : 'Run stopped.',
  );
}
