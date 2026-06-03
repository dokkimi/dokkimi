import { spawn } from 'child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findDokkimiBin } from '../lib/find-bin';

export function registerClean(server: McpServer): void {
  server.tool(
    'clean',
    'Stops all running instances and cleans up Docker resources. Use this to recover from stuck state before re-running tests. This is a destructive operation — it force-stops everything.',
    {},
    async () => {
      const bin = findDokkimiBin();
      const isNodeScript = bin.endsWith('.js');
      const command = isNodeScript ? process.execPath : bin;
      const args = isNodeScript
        ? [bin, 'clean', '--force', '--json']
        : ['clean', '--force', '--json'];

      return new Promise((resolve) => {
        const child = spawn(command, args, {
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
          try {
            const result = JSON.parse(stdout);
            resolve({
              content: [
                { type: 'text', text: JSON.stringify(result, null, 2) },
              ],
              isError: !result.success,
            });
          } catch {
            resolve({
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      success: code === 0,
                      error: stderr.trim() || 'Failed to parse clean output',
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
