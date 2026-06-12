import { spawn } from 'child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findDokkimiBin } from '../lib/find-bin';

export function registerStop(server: McpServer): void {
  server.tool(
    'stop',
    'Stops the current test run without cleaning up history or data. Use this when you need to cancel a run in progress but want to preserve results from previous runs.',
    {},
    async () => {
      const bin = findDokkimiBin();
      const isNodeScript = bin.endsWith('.js');
      const command = isNodeScript ? process.execPath : bin;
      const args = isNodeScript ? [bin, 'stop', '--json'] : ['stop', '--json'];

      return new Promise((resolve) => {
        const child = spawn(command, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
        });

        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });

        child.on('close', () => {
          try {
            const result = JSON.parse(stdout);
            resolve({
              content: [
                { type: 'text', text: JSON.stringify(result, null, 2) },
              ],
            });
          } catch {
            resolve({
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    { error: 'Failed to parse stop output' },
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
