import { shutdownServices } from '@dokkimi/service-manager';
import { findProcessesByPattern, killProcess } from '@dokkimi/platform';

export async function shutdown(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: dokkimi shutdown');
    console.log('');
    console.log('Stop all running Dokkimi processes.');
    process.exit(0);
  }

  // Stop Electron app if running
  killElectron();

  // Stop Control Tower
  await shutdownServices();
}

function killElectron(): void {
  const pids = findProcessesByPattern('electron.*desktop|Dokkimi');
  if (pids.length === 0) {
    return;
  }

  console.log(`[Dokkimi] Stopping desktop app (pid ${pids.join(', ')})...`);
  for (const pid of pids) {
    killProcess(pid);
  }
}
