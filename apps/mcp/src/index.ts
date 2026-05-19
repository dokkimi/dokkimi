import { DOKKIMI_VERSION } from '@dokkimi/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerGetReference } from './tools/get-reference.js';
import { registerListFragments } from './tools/list-fragments.js';
import { registerListDefinitions } from './tools/list-definitions.js';
import { registerValidateFile } from './tools/validate-file.js';
import { registerResolveDefinition } from './tools/resolve-definition.js';
import { registerRunTests } from './tools/run-tests.js';
import { registerDumpResults } from './tools/dump-results.js';
import { registerDoctor } from './tools/doctor.js';
import { registerStatus } from './tools/status.js';
import { registerClean } from './tools/clean.js';
import { registerReboot } from './tools/reboot.js';
import { registerSpecResource } from './resources/spec.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'dokkimi',
    version: DOKKIMI_VERSION,
  });

  registerGetReference(server);
  registerListFragments(server);
  registerListDefinitions(server);
  registerValidateFile(server);
  registerResolveDefinition(server);
  registerRunTests(server);
  registerDumpResults(server);
  registerDoctor(server);
  registerStatus(server);
  registerClean(server);
  registerReboot(server);
  registerSpecResource(server);

  return server;
}

export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
