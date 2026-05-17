import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const DUMP_DIR = path.join(os.homedir(), '.dokkimi', 'generated');

function findDokkimiBin(): string {
  const localBin = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'cli',
    'dist',
    'bin',
    'dokkimi.js',
  );
  if (fs.existsSync(localBin)) {
    return localBin;
  }
  return 'dokkimi';
}

export function registerDumpResults(server: McpServer): void {
  server.tool(
    'dump_results',
    'Regenerates the dump output from the last run and returns the file path. Use run_tests output paths for the common case.',
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
      const outputFile = failedOnly
        ? path.join(DUMP_DIR, 'dump_failed.json')
        : path.join(DUMP_DIR, 'dump.json');

      const args = ['dump'];
      if (target) {
        args.push(target);
      }
      if (failedOnly) {
        args.push('--failed');
      }
      args.push('-o', outputFile);

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
          if (code === 0) {
            resolve({
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ filePath: outputFile }, null, 2),
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
                      filePath: outputFile,
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
