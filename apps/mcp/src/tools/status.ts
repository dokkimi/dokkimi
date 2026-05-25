import { spawn } from 'child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findDokkimiBin } from '../lib/find-bin';

export function registerStatus(server: McpServer): void {
  server.tool(
    'status',
    'Returns whether Dokkimi is running, Kubernetes connectivity, and any active/stopped instances.',
    {},
    async () => {
      const bin = findDokkimiBin();
      const isNodeScript = bin.endsWith('.js');
      const command = isNodeScript ? process.execPath : bin;
      const args = isNodeScript
        ? [bin, 'status', '--json']
        : ['status', '--json'];

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
                    { error: 'Failed to parse status output' },
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
