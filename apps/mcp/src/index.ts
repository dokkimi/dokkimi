import { DOKKIMI_VERSION } from '@dokkimi/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerGetReference } from './tools/get-reference';
import { registerListFragments } from './tools/list-fragments';
import { registerListDefinitions } from './tools/list-definitions';
import { registerValidateFile } from './tools/validate-file';
import { registerResolveDefinition } from './tools/resolve-definition';
import { registerRunTests } from './tools/run-tests';
import { registerDumpResults } from './tools/dump-results';
import { registerDoctor } from './tools/doctor';
import { registerStatus } from './tools/status';
import { registerClean } from './tools/clean';
import { registerReboot } from './tools/reboot';
import { registerGetConfig, registerSetConfig } from './tools/config';
import { registerSendFeedback } from './tools/send-feedback';
import { registerGetRunSummary } from './tools/get-run-summary';
import { registerGetFailures } from './tools/get-failures';
import { registerGetStepDetail } from './tools/get-step-detail';
import { registerGetTraffic } from './tools/get-traffic';
import { registerGetConsoleLogs } from './tools/get-console-logs';
import { registerGetDbLogs } from './tools/get-db-logs';
import { registerGetContainerStatus } from './tools/get-container-status';
import { registerWatchRun } from './tools/watch-run';
import { registerGetRunHistory } from './tools/get-run-history';
import { registerDiagnose } from './tools/diagnose';
import { registerDiffTraffic } from './tools/diff-traffic';
import { registerSpecResource } from './resources/spec';
import { withToolTracking } from './lib/tracked-server';

export function createServer(): McpServer {
  const server = withToolTracking(
    new McpServer({
      name: 'dokkimi',
      version: DOKKIMI_VERSION,
    }),
  );

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
  registerGetConfig(server);
  registerSetConfig(server);
  registerSendFeedback(server);
  registerGetRunSummary(server);
  registerGetFailures(server);
  registerGetStepDetail(server);
  registerGetTraffic(server);
  registerGetConsoleLogs(server);
  registerGetDbLogs(server);
  registerGetContainerStatus(server);
  registerWatchRun(server);
  registerGetRunHistory(server);
  registerDiagnose(server);
  registerDiffTraffic(server);
  registerSpecResource(server);

  return server;
}

export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
