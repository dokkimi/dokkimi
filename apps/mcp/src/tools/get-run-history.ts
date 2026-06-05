import * as path from 'path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ctFetch } from '../lib/ct-client';
import { findDokkimiDir } from '../lib/dokkimi-dir';
import type { LatestRunResponse } from '../lib/ct-types';

export function registerGetRunHistory(server: McpServer): void {
  server.tool(
    'get_run_history',
    'Returns the last N test runs for the current project with status and timing. Useful for comparing results across runs or finding when a test started failing.',
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Number of runs to return (default: 10)'),
    },
    async ({ limit }) => {
      try {
        const dokkimiDir = findDokkimiDir(process.cwd());
        const projectPath = dokkimiDir ? path.dirname(dokkimiDir) : undefined;

        const runs = await ctFetch<LatestRunResponse[]>('/runs/history', {
          ...(projectPath ? { projectPath } : {}),
          ...(limit ? { limit: String(limit) } : {}),
        });

        if (runs.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    message:
                      'No run history found. Run tests first with run_tests.',
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        const result = runs.map((run) => {
          let passed = 0;
          let failed = 0;

          for (const inst of run.instances) {
            const status = inst.testStatus ?? inst.status;
            if (status === 'PASSED' || status === 'COMPLETED') {
              passed++;
            } else if (status === 'FAILED') {
              failed++;
            }
          }

          return {
            runId: run.runId,
            status: run.status,
            createdAt: run.createdAt,
            completedAt: run.completedAt,
            summary: { total: run.instances.length, passed, failed },
          };
        });

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
                      : 'Failed to fetch run history',
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
