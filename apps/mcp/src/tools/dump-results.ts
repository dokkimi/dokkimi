import { spawn } from 'child_process';
import * as path from 'path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findDokkimiBin } from '../lib/find-bin';
import { findDokkimiDir } from '../lib/dokkimi-dir';
import { ctFetch } from '../lib/ct-client';

interface HistoryRun {
  runId: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
}

export function registerDumpResults(server: McpServer): void {
  server.tool(
    'dump_results',
    "Exports a run's full data dump to a JSON file for external consumption (sharing, archiving, CI). Use runIndex to target a previous run (1 = latest, 2 = second most recent, etc.). For targeted debugging, prefer get_run_summary, get_failures, get_step_detail, get_traffic, get_console_logs, or get_db_logs instead.",
    {
      target: z
        .string()
        .optional()
        .describe('Filter to a specific definition file'),
      failedOnly: z
        .boolean()
        .optional()
        .describe('If true, only include failed instances. Defaults to false.'),
      runIndex: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'Which run to dump: 1 = latest (default), 2 = second most recent, etc. Use get_run_history to see available runs.',
        ),
    },
    async ({ target, failedOnly, runIndex }) => {
      const bin = findDokkimiBin();

      const args = ['dump'];
      if (target) {
        args.push(target);
      }
      if (failedOnly) {
        args.push('--failed');
      }

      if (runIndex && runIndex > 1) {
        const dokkimiDir = findDokkimiDir(process.cwd());
        const projectPath = dokkimiDir ? path.dirname(dokkimiDir) : undefined;
        const params: Record<string, string> = { limit: String(runIndex) };
        if (projectPath) {
          params.projectPath = projectPath;
        }
        const history = await ctFetch<HistoryRun[]>('/runs/history', params);
        if (!history || history.length < runIndex) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: `Run index ${runIndex} not found. Only ${history?.length ?? 0} run(s) available.`,
                }),
              },
            ],
            isError: true,
          };
        }
        const targetRun = history[runIndex - 1];
        args.push('--run', targetRun.runId);
      }

      const isNodeScript = bin.endsWith('.js');
      const command = isNodeScript ? process.execPath : bin;
      const spawnArgs = isNodeScript ? [bin, ...args] : args;

      return new Promise((resolve) => {
        const child = spawn(command, spawnArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        child.on('close', (code) => {
          const pathMatch =
            stdout.match(/Dump written to (.+)/) ??
            stderr.match(/Dump written to (.+)/);
          const filePath = pathMatch?.[1]?.trim() ?? null;

          if (code === 0) {
            resolve({
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ filePath }, null, 2),
                },
              ],
            });
          } else {
            resolve({
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      filePath,
                      error: stderr.trim() || `dump exited with code ${code}`,
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            });
          }
        });

        child.on('error', (err) => {
          resolve({
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  { error: `Failed to spawn dokkimi: ${err.message}` },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          });
        });
      });
    },
  );
}
