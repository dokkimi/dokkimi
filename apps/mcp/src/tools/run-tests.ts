import * as path from 'path';
import { spawn } from 'child_process';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findDokkimiBin } from '../lib/find-bin';
import { findDokkimiDir } from '../lib/dokkimi-dir';
import { ctFetchOrNull } from '../lib/ct-client';
import type { LatestRunResponse } from '../lib/ct-types';

interface RunResult {
  success: boolean;
  runId?: string;
  summary: { total: number; passed: number; failed: number; skipped: number };
  instances: {
    id: string;
    name: string;
    status: string;
    errorMessage?: string;
  }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function buildRunResult(projectPath?: string): Promise<RunResult | null> {
  // Brief retry — CT may still be finalizing the run status after the CLI exits.
  let run: LatestRunResponse | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    run = await ctFetchOrNull<LatestRunResponse>(
      '/runs/latest',
      projectPath ? { projectPath } : undefined,
    );
    if (run && run.status !== 'PENDING' && run.status !== 'RUNNING') {
      break;
    }
    await sleep(500);
  }
  if (!run) {
    return null;
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

  return {
    success: failed === 0,
    runId: run.runId,
    summary: { total: run.instances.length, passed, failed, skipped },
    instances,
  };
}

export function registerRunTests(server: McpServer): void {
  server.tool(
    'run_tests',
    'Executes dokkimi run against a definition file or pattern and returns structured results. IMPORTANT: Only invoke this tool once at a time. Parallel or sequential calls will overwrite previous results. To run multiple definition files, use a glob pattern (e.g. database/redis-*) or a subfolder path, not separate calls. After a failed run, use get_failures, get_step_detail, get_traffic, get_console_logs, or get_db_logs to drill into specific issues.',
    {
      target: z
        .string()
        .optional()
        .describe(
          'File path, pattern, or subfolder (same as `dokkimi run` target). Defaults to the full .dokkimi/ directory.',
        ),
      failedOnly: z
        .boolean()
        .optional()
        .describe(
          'Re-run only definitions that failed in the last run. Requires a prior run to have completed with failures.',
        ),
    },
    async ({ target, failedOnly }, { sendNotification }) => {
      const bin = findDokkimiBin();
      const args = ['run'];
      if (target) {
        args.push(target);
      }
      args.push('--ci');
      if (failedOnly) {
        args.push('--failed');
      }

      const dokkimiDir = findDokkimiDir(process.cwd());
      const projectPath = dokkimiDir ? path.dirname(dokkimiDir) : undefined;

      const isNodeScript = bin.endsWith('.js');
      const command = isNodeScript ? process.execPath : bin;
      const spawnArgs = isNodeScript ? [bin, ...args] : args;

      const TIMEOUT_MS = 10 * 60 * 1000;

      return new Promise((resolve) => {
        const child = spawn(command, spawnArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
          cwd: projectPath ?? process.cwd(),
        });

        const timer = setTimeout(() => {
          child.kill();
          resolve({
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    success: false,
                    error: `dokkimi run timed out after ${TIMEOUT_MS / 1000}s`,
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

        child.on('close', async (code) => {
          clearTimeout(timer);
          if (stdoutBuf.trim()) {
            forwardLine(stdoutBuf);
          }
          if (stderrBuf.trim()) {
            forwardLine(stderrBuf);
          }

          let result: RunResult | null = null;
          try {
            result = await buildRunResult(projectPath);
          } catch {}

          if (result) {
            resolve({
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(result, null, 2),
                },
              ],
              isError: !result.success,
            });
          } else {
            resolve({
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    {
                      success: code === 0,
                      summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
                      instances: [],
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
                type: 'text' as const,
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
