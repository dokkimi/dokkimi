import { spawn } from 'child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findDokkimiBin } from '../lib/find-bin';

export function registerReboot(server: McpServer): void {
  server.tool(
    'reboot',
    'Restarts Dokkimi services. Use after config changes that require a reboot (concurrency, K8s context). WARNING: this will interrupt any running instances — call status first to check.',
    {},
    async () => {
      const bin = findDokkimiBin();
      const isNodeScript = bin.endsWith('.js');
      const command = isNodeScript ? process.execPath : bin;
      const args = isNodeScript ? [bin, 'reboot'] : ['reboot'];

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
          resolve({
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: code === 0,
                    output: (stdout + stderr).trim(),
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: code !== 0,
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
