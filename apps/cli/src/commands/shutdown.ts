import { shutdownServices } from '@dokkimi/service-manager';

export async function shutdown(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: dokkimi shutdown');
    console.log('');
    console.log('Stop all running Dokkimi processes.');
    process.exit(0);
  }

  await shutdownServices();
}
