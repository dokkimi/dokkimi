import { spawn } from 'child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findDokkimiBin } from '../lib/find-bin.js';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[\d+m/g;

interface StatusResult {
  running: boolean;
  kubernetes?: boolean;
  instances: { name: string; status: string }[];
}

function parseOutput(raw: string): StatusResult {
  const text = raw.replace(ANSI_RE, '');
  const running = text.includes('Dokkimi is running');

  if (!running) {
    return { running: false, instances: [] };
  }

  const kubernetes = text.includes('Kubernetes connected')
    ? true
    : text.includes('Kubernetes not connected')
      ? false
      : undefined;

  const instances: { name: string; status: string }[] = [];
  const instanceRe =
    /^\s*(RUNNING|DEPLOYING|STOPPING|STOPPED|FAILED)\s+(\S+)/gm;
  let match;
  while ((match = instanceRe.exec(text)) !== null) {
    instances.push({ name: match[2], status: match[1] });
  }

  return { running, kubernetes, instances };
}

export function registerStatus(server: McpServer): void {
  server.tool(
    'status',
    'Returns whether Dokkimi is running, Kubernetes connectivity, and any active/stopped instances.',
    {},
    async () => {
      const bin = findDokkimiBin();
      const isNodeScript = bin.endsWith('.js');
      const command = isNodeScript ? process.execPath : bin;
      const args = isNodeScript ? [bin, 'status'] : ['status'];

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
          const result = parseOutput(stdout);
          resolve({
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
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
