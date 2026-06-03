import * as path from 'path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ctFetchOrNull } from '../lib/ct-client';
import { findDokkimiDir } from '../lib/dokkimi-dir';
import type { LatestRunResponse } from '../lib/ct-types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

export function registerWatchRun(server: McpServer): void {
  server.tool(
    'watch_run',
    'Polls until the current run completes and returns the final summary. Use this after run_tests to wait for results without manual polling. Times out after 10 minutes.',
    {
      runId: z
        .string()
        .optional()
        .describe('Run ID to watch. If omitted, watches the latest run.'),
      pollIntervalMs: z
        .number()
        .int()
        .min(500)
        .max(30000)
        .optional()
        .describe('Poll interval in milliseconds (default: 3000)'),
    },
    async ({ runId, pollIntervalMs }, { sendNotification }) => {
      try {
        const dokkimiDir = findDokkimiDir(process.cwd());
        const projectPath = dokkimiDir ? path.dirname(dokkimiDir) : undefined;
        const interval = pollIntervalMs ?? 3000;
        const timeoutMs = 10 * 60 * 1000;
        const start = Date.now();

        let lastStatus = '';

        while (Date.now() - start < timeoutMs) {
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
                    {
                      error: 'No run found. Start a run with run_tests first.',
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }

          if (runId && run.runId !== runId) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    {
                      error: `Run ${runId} not found. Latest run is ${run.runId}.`,
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }

          if (TERMINAL_STATUSES.has(run.status)) {
            let passed = 0;
            let failed = 0;
            let skipped = 0;

            const instances = run.instances.map((inst) => {
              const status = inst.testStatus ?? inst.status;
              if (status === 'PASSED' || status === 'COMPLETED') {
                passed++;
              } else if (status === 'FAILED') {
                failed++;
              } else if (status === 'SKIPPED') {
                skipped++;
              }
              return {
                id: inst.id,
                name: inst.name,
                status,
                ...(inst.errorMessage
                  ? { errorMessage: inst.errorMessage }
                  : {}),
              };
            });

            const result = {
              runId: run.runId,
              status: run.status,
              summary: {
                total: run.instances.length,
                passed,
                failed,
                skipped,
              },
              instances,
            };

            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(result, null, 2),
                },
              ],
              isError: failed > 0,
            };
          }

          const statusLine = `${run.status} — ${run.instances.length} instance(s)`;
          if (statusLine !== lastStatus) {
            lastStatus = statusLine;
            sendNotification({
              method: 'notifications/message',
              params: {
                level: 'info',
                data: `Run ${run.runId}: ${statusLine}`,
              },
            }).catch(() => {});
          }

          await sleep(interval);
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  error: 'Timed out waiting for run to complete (10 minutes).',
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  error:
                    err instanceof Error ? err.message : 'Failed to watch run',
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
