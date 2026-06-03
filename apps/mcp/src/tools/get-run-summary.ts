import * as path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ctFetchOrNull } from '../lib/ct-client';
import { findDokkimiDir } from '../lib/dokkimi-dir';
import type { LatestRunResponse } from '../lib/ct-types';

export function registerGetRunSummary(server: McpServer): void {
  server.tool(
    'get_run_summary',
    'Returns a summary of the latest test run for the current project: run status, per-definition pass/fail, error messages, and timing. Use this after run_tests to see what happened.',
    {},
    async () => {
      try {
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
            ...(inst.errorMessage ? { errorMessage: inst.errorMessage } : {}),
          };
        });

        const result = {
          runId: run.runId,
          status: run.status,
          createdAt: run.createdAt,
          completedAt: run.completedAt,
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
                      : 'Failed to fetch run summary',
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
