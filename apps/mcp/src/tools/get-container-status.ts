import * as path from 'path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ctFetch, ctFetchOrNull } from '../lib/ct-client';
import { findDokkimiDir } from '../lib/dokkimi-dir';
import type { InstanceDetail, LatestRunResponse } from '../lib/ct-types';

export function registerGetContainerStatus(server: McpServer): void {
  server.tool(
    'get_container_status',
    'Returns the status and readiness of each container (service, database, mock) in an instance. Shows which containers are running, crashed, or not ready. If no instanceId is provided, uses the first instance from the latest run.',
    {
      instanceId: z
        .string()
        .optional()
        .describe(
          'Instance ID. If omitted, uses the first instance from the latest run.',
        ),
    },
    async ({ instanceId }) => {
      try {
        let resolvedInstanceId = instanceId;

        if (!resolvedInstanceId) {
          const dokkimiDir = findDokkimiDir(process.cwd());
          const projectPath = dokkimiDir ? path.dirname(dokkimiDir) : undefined;
          const run = await ctFetchOrNull<LatestRunResponse>(
            '/runs/latest',
            projectPath ? { projectPath } : undefined,
          );
          if (!run || run.instances.length === 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    {
                      error:
                        'No run found. Run tests first with run_tests, or provide an instanceId.',
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }
          resolvedInstanceId = run.instances[0].id;
        }

        const instance = await ctFetch<InstanceDetail>(
          `/namespaces/instances/${resolvedInstanceId}`,
        );

        const result = {
          instanceId: resolvedInstanceId,
          containers: instance.items.map((item) => ({
            name: item.itemDefinitionName,
            status: item.status,
            readiness: item.readinessStatus ?? 'UNKNOWN',
          })),
        };

        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(result, null, 2) },
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
                      : 'Failed to fetch container status',
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
