import { spawn } from 'child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findDokkimiBin } from '../lib/find-bin.js';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[\d+m/g;

export function registerClean(server: McpServer): void {
  server.tool(
    'clean',
    'Stops all running instances and cleans up K8s namespaces. Use this to recover from stuck state before re-running tests. This is a destructive operation — it force-stops everything.',
    {},
    async () => {
      const bin = findDokkimiBin();
      const isNodeScript = bin.endsWith('.js');
      const command = isNodeScript ? process.execPath : bin;
      const args = isNodeScript
        ? [bin, 'clean', '--force']
        : ['clean', '--force'];

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
          const output = (stdout + stderr).replace(ANSI_RE, '').trim();
          const success = code === 0 || output.includes('Clean complete');

          resolve({
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success,
                    output,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: !success,
          });
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
