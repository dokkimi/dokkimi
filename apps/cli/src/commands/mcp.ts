import { startServer } from '@dokkimi/mcp';

export async function mcp(): Promise<void> {
  await startServer();
}
