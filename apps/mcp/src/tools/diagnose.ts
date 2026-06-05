import * as path from 'path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ctFetch, ctFetchOrNull } from '../lib/ct-client';
import { findDokkimiDir } from '../lib/dokkimi-dir';
import type {
  LatestRunResponse,
  AssertionResult,
  HttpLog,
  ConsoleLog,
  TestExecutionLog,
  PaginatedResponse,
  InstanceDetail,
} from '../lib/ct-types';

export function registerDiagnose(server: McpServer): void {
  server.tool(
    'diagnose',
    'Cross-references failures with traffic, container status, and console logs from the latest run. Returns a surgical diagnosis for each failed instance in one call instead of requiring multiple tool calls. Use after a run fails to understand what went wrong.',
    {
      instanceId: z
        .string()
        .optional()
        .describe(
          'Diagnose a specific instance. If omitted, diagnoses all failed instances from the latest run.',
        ),
    },
    async ({ instanceId }) => {
      try {
        let targetInstances: {
          id: string;
          name: string;
          errorMessage?: string;
        }[];

        if (instanceId) {
          targetInstances = [{ id: instanceId, name: '' }];
        } else {
          const dokkimiDir = findDokkimiDir(process.cwd());
          const projectPath = dokkimiDir ? path.dirname(dokkimiDir) : undefined;

          const run = await ctFetchOrNull<LatestRunResponse>(
            '/runs/latest',
            projectPath ? { projectPath } : undefined,
          );

          if (!run) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    { error: 'No run found. Run tests first with run_tests.' },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }

          const failed = run.instances.filter(
            (i) => (i.testStatus ?? i.status) === 'FAILED',
          );

          if (failed.length === 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    { message: 'No failures found. All tests passed.' },
                    null,
                    2,
                  ),
                },
              ],
            };
          }

          targetInstances = failed.map((i) => ({
            id: i.id,
            name: i.name,
            errorMessage: i.errorMessage,
          }));
        }

        const diagnoses = await Promise.all(
          targetInstances.map(async (inst) => {
            const [assertions, detail, traffic, consoleLogs, execLogs] =
              await Promise.all([
                ctFetch<AssertionResult[]>(
                  `/logs/assertion-results/instance/${inst.id}`,
                ).catch(() => []),
                ctFetch<InstanceDetail>(
                  `/namespaces/instances/${inst.id}`,
                ).catch(() => null),
                ctFetch<PaginatedResponse<HttpLog>>(
                  `/logs/http/instance/${inst.id}`,
                  { limit: '50' },
                ).catch(() => ({
                  logs: [] as HttpLog[],
                  total: 0,
                  limit: 50,
                  offset: 0,
                })),
                ctFetch<PaginatedResponse<ConsoleLog>>(
                  `/logs/console/instance/${inst.id}`,
                  { limit: '100' },
                ).catch(() => ({
                  logs: [] as ConsoleLog[],
                  total: 0,
                  limit: 100,
                  offset: 0,
                })),
                ctFetch<PaginatedResponse<TestExecutionLog>>(
                  `/logs/test-execution/instance/${inst.id}`,
                ).catch(() => ({
                  logs: [] as TestExecutionLog[],
                  total: 0,
                  limit: 1000,
                  offset: 0,
                })),
              ]);

            const failedAssertions = assertions.filter((a) => !a.passed);
            const errorLogs = execLogs.logs.filter(
              (l) => l.eventType === 'step_error' || l.error,
            );
            const failedRequests = traffic.logs.filter(
              (l) => l.statusCode && l.statusCode >= 400,
            );
            const notReadyItems = (detail?.items ?? []).filter(
              (i) => i.readinessStatus !== 'READY',
            );

            return {
              instanceId: inst.id,
              instanceName: inst.name,
              errorMessage: inst.errorMessage ?? null,
              containers: {
                notReady: notReadyItems.map((i) => ({
                  name: i.itemDefinitionName,
                  status: i.status,
                  readiness: i.readinessStatus,
                })),
              },
              failedAssertions: failedAssertions.map((a) => ({
                stepIndex: a.stepIndex,
                path: a.path,
                operator: a.operator,
                expected: a.expected,
                actual: a.actual,
                error: a.error,
              })),
              errors: errorLogs.map((l) => ({
                stepIndex: l.stepIndex,
                message: l.message,
                error: l.error,
                errorType: l.errorType,
              })),
              failedRequests: failedRequests.map((l) => ({
                method: l.method,
                url: l.url,
                statusCode: l.statusCode,
                origin: l.origin,
                target: l.target,
              })),
              recentConsole: consoleLogs.logs.slice(0, 20).map((l) => ({
                level: l.level,
                message: l.message,
                timestamp: l.timestamp,
              })),
            };
          }),
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(diagnoses, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  error:
                    err instanceof Error
                      ? err.message
                      : 'Failed to diagnose run',
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
