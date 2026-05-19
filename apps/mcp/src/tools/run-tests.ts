import * as fs from 'fs';
import { spawn } from 'child_process';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DUMP_PATH, DUMP_FAILED_PATH } from '@dokkimi/config';
import { findDokkimiBin } from '../lib/find-bin.js';

interface RunResult {
  success: boolean;
  summary: { total: number; passed: number; failed: number; skipped: number };
  results: {
    definitionName: string;
    status: string;
    errorMessage?: string;
  }[];
  dumpFilePath: string;
  dumpFailedFilePath: string;
}

function parseDumpFile(dumpPath: string): RunResult | null {
  if (!fs.existsSync(dumpPath)) {
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(dumpPath, 'utf-8'));
    const instances: {
      name: string;
      status: string;
      testStatus?: string;
      errorMessage?: string;
    }[] = raw.instances ?? [];

    let passed = 0;
    let failed = 0;
    let skipped = 0;

    const results = instances.map((inst) => {
      const status = inst.testStatus ?? inst.status;
      if (status === 'PASSED' || status === 'COMPLETED') {
        passed++;
      } else if (status === 'FAILED') {
        failed++;
      } else if (status === 'SKIPPED') {
        skipped++;
      }

      return {
        definitionName: inst.name,
        status,
        ...(inst.errorMessage ? { errorMessage: inst.errorMessage } : {}),
      };
    });

    return {
      success: failed === 0,
      summary: { total: instances.length, passed, failed, skipped },
      results,
      dumpFilePath: DUMP_PATH,
      dumpFailedFilePath: DUMP_FAILED_PATH,
    };
  } catch {
    return null;
  }
}

export function registerRunTests(server: McpServer): void {
  server.tool(
    'run_tests',
    'Executes dokkimi run against a definition file or pattern and returns structured results with dump file paths.',
    {
      target: z
        .string()
        .optional()
        .describe(
          'File path, pattern, or subfolder (same as `dokkimi run` target). Defaults to the full .dokkimi/ directory.',
        ),
    },
    async ({ target }, { sendNotification }) => {
      const bin = findDokkimiBin();
      const args = ['run'];
      if (target) {
        args.push(target);
      }
      args.push('--ci');

      const isNodeScript = bin.endsWith('.js');
      const command = isNodeScript ? process.execPath : bin;
      const spawnArgs = isNodeScript ? [bin, ...args] : args;

      const TIMEOUT_MS = 10 * 60 * 1000;

      return new Promise((resolve) => {
        const child = spawn(command, spawnArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
        });

        const timer = setTimeout(() => {
          child.kill();
          resolve({
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: false,
                    error: `dokkimi run timed out after ${TIMEOUT_MS / 1000}s`,
                    dumpFilePath: DUMP_PATH,
                    dumpFailedFilePath: DUMP_FAILED_PATH,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          });
        }, TIMEOUT_MS);

        const forwardLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) {
            return;
          }
          sendNotification({
            method: 'notifications/message',
            params: {
              level: 'info',
              data: trimmed,
            },
          }).catch(() => {});
        };

        let stdoutBuf = '';
        let stderrBuf = '';

        child.stdout.on('data', (chunk: Buffer) => {
          stdoutBuf += chunk.toString();
          const lines = stdoutBuf.split('\n');
          stdoutBuf = lines.pop()!;
          for (const line of lines) {
            forwardLine(line);
          }
        });

        child.stderr.on('data', (chunk: Buffer) => {
          stderrBuf += chunk.toString();
          const lines = stderrBuf.split('\n');
          stderrBuf = lines.pop()!;
          for (const line of lines) {
            forwardLine(line);
          }
        });

        child.on('close', (code) => {
          clearTimeout(timer);
          if (stdoutBuf.trim()) {
            forwardLine(stdoutBuf);
          }
          if (stderrBuf.trim()) {
            forwardLine(stderrBuf);
          }

          const parsed = parseDumpFile(DUMP_PATH);

          if (parsed) {
            resolve({
              content: [
                { type: 'text', text: JSON.stringify(parsed, null, 2) },
              ],
              isError: !parsed.success,
            });
          } else {
            resolve({
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      success: code === 0,
                      summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
                      results: [],
                      dumpFilePath: DUMP_PATH,
                      dumpFailedFilePath: DUMP_FAILED_PATH,
                      error: `dokkimi run exited with code ${code}`,
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: code !== 0,
            });
          }
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          resolve({
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: false,
                    error: `Failed to spawn dokkimi: ${err.message}`,
                  },
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
