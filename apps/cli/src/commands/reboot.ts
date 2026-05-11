import {
  shutdownServices,
  ensureServicesRunning,
  resolveAppRoot,
} from '@dokkimi/service-manager';
import { loadConfig } from '@dokkimi/config';

export async function reboot(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: dokkimi reboot');
    console.log('');
    console.log('Restart Dokkimi.');
    process.exit(0);
  }

  await shutdownServices();

  const config = loadConfig();
  const appRoot = resolveAppRoot(__dirname);
  await ensureServicesRunning(appRoot, config);
}
