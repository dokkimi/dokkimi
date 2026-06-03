import { spawn } from 'child_process';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findDokkimiBin } from '../lib/find-bin';

export function registerDumpResults(server: McpServer): void {
  server.tool(
    'dump_results',
    "Exports the last run's full data dump to a JSON file for external consumption (sharing, archiving, CI). For targeted debugging, prefer get_run_summary, get_failures, get_step_detail, get_traffic, get_console_logs, or get_db_logs instead.",
    {
      target: z
        .string()
        .optional()
        .describe('Filter to a specific definition file'),
      failedOnly: z
        .boolean()
        .optional()
        .describe('If true, only include failed instances. Defaults to false.'),
    },
    async ({ target, failedOnly }) => {
      const bin = findDokkimiBin();

      const args = ['dump'];
      if (target) {
        args.push(target);
      }
      if (failedOnly) {
        args.push('--failed');
      }

      const isNodeScript = bin.endsWith('.js');
      const command = isNodeScript ? process.execPath : bin;
      const spawnArgs = isNodeScript ? [bin, ...args] : args;

      return new Promise((resolve) => {
        const child = spawn(command, spawnArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
        });

        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        child.on('close', (code) => {
          const filePathMatch = stderr.match(/Dump written to (.+)/);
          const filePath = filePathMatch?.[1]?.trim() ?? null;

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
