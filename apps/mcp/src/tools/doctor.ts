import { spawn } from 'child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findDokkimiBin } from '../lib/find-bin.js';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[\d+m/g;
const CHECK_RE = /^\s*[✓✗○]\s+(\S+(?:\s+\S+)*?)\s{2,}(.+)$/;
const FIX_RE = /^\s*↳\s*(.+)$/;

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
  fix?: string;
}

function parseOutput(raw: string): CheckResult[] {
  const lines = raw.replace(ANSI_RE, '').split('\n');
  const results: CheckResult[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = CHECK_RE.exec(lines[i]);
    if (!match) {
      continue;
    }

    const [, name, detail] = match;
    const passed = lines[i].includes('✓');
    const result: CheckResult = { name, passed, detail: detail.trim() };

    const nextLine = lines[i + 1];
    if (nextLine) {
      const fixMatch = FIX_RE.exec(nextLine.replace(ANSI_RE, ''));
      if (fixMatch) {
        result.fix = fixMatch[1].trim();
      }
    }

    results.push(result);
  }

  return results;
}

export function registerDoctor(server: McpServer): void {
  server.tool(
    'doctor',
    'Runs environment pre-flight checks (Docker, Kubernetes, disk space, database, etc.) and returns structured results. Call this to diagnose why run_tests might be failing.',
    {},
    async () => {
      const bin = findDokkimiBin();
      const isNodeScript = bin.endsWith('.js');
      const command = isNodeScript ? process.execPath : bin;
      const args = isNodeScript ? [bin, 'doctor'] : ['doctor'];

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
          const checks = parseOutput(stdout);
          const failed = checks.filter((c) => !c.passed);

          resolve({
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    passed: code === 0,
                    checks,
                    ...(failed.length > 0 ? { failed } : {}),
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
