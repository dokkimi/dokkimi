import { spawn } from 'child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findDokkimiBin } from '../lib/find-bin';

export function registerDoctor(server: McpServer): void {
  server.tool(
    'doctor',
    'Runs environment pre-flight checks (Docker, disk space, database, run storage, etc.) and returns structured results. Warns when the database or run storage directory grows large. Call this to diagnose why run_tests might be failing.',
    {},
    async () => {
      const bin = findDokkimiBin();
      const isNodeScript = bin.endsWith('.js');
      const command = isNodeScript ? process.execPath : bin;
      const args = isNodeScript
        ? [bin, 'doctor', '--json']
        : ['doctor', '--json'];

      return new Promise((resolve) => {
        const child = spawn(command, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
        });

        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });

        child.on('close', (code) => {
          try {
            const result = JSON.parse(stdout);
            resolve({
              content: [
                { type: 'text', text: JSON.stringify(result, null, 2) },
              ],
              isError: code !== 0,
            });
          } catch {
            resolve({
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      error: 'Failed to parse doctor output',
                      exitCode: code,
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
