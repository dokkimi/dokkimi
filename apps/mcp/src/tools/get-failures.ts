import * as path from 'path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ctFetch, ctFetchOrNull } from '../lib/ct-client';
import { findDokkimiDir } from '../lib/dokkimi-dir';
import { instanceOutcome } from '@dokkimi/config';
import { endedWithoutPassing } from '../lib/run-outcomes';
import type {
  LatestRunResponse,
  AssertionResult,
  InstanceSummary,
} from '../lib/ct-types';

export function registerGetFailures(server: McpServer): void {
  server.tool(
    'get_failures',
    'Returns failed assertion details from the latest test run. If instanceId is provided, returns failures for that specific instance. Otherwise, returns failures for all failed instances in the latest run.',
    {
      instanceId: z
        .string()
        .optional()
        .describe(
          'Instance ID to get failures for. If omitted, gets failures for all failed instances.',
        ),
    },
    async ({ instanceId }) => {
      try {
        let failedInstances: InstanceSummary[];
        let outcomes = new Map<string, string>();

        if (instanceId) {
          failedInstances = [{ id: instanceId, name: '', status: 'FAILED' }];
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

          const ended = endedWithoutPassing(run);
          if ('message' in ended) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ message: ended.message }, null, 2),
                },
              ],
            };
          }
          outcomes = new Map(
            ended.instances.map((i) => [i.id, instanceOutcome(run.status, i)]),
          );
          failedInstances = ended.instances;
        }

        const results = await Promise.all(
          failedInstances.map(async (inst) => {
            try {
              const assertions = await ctFetch<AssertionResult[]>(
                `/logs/assertion-results/instance/${inst.id}`,
              );
              const failed = assertions.filter((a) => !a.passed);
              return {
                instanceId: inst.id,
                instanceName: inst.name,
                ...(outcomes.has(inst.id)
                  ? { outcome: outcomes.get(inst.id) }
                  : {}),
                errorMessage: inst.errorMessage,
                failedAssertions: failed.map((a) => ({
                  stepIndex: a.stepIndex,
                  blockIndex: a.blockIndex,
                  assertionIndex: a.assertionIndex,
                  path: a.path,
                  operator: a.operator,
                  expected: a.expected,
                  actual: a.actual,
                  error: a.error,
                })),
              };
            } catch (err) {
              return {
                instanceId: inst.id,
                instanceName: inst.name,
                error:
                  err instanceof Error
                    ? err.message
                    : 'Failed to fetch results',
              };
            }
          }),
        );

        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(results, null, 2) },
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
                      : 'Failed to fetch failures',
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
