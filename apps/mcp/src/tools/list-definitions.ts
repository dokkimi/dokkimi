import * as fs from 'fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { parseDefinitionFile } from '@dokkimi/definition-validator';
import { findDokkimiDir, scanFiles } from '../lib/dokkimi-dir';

interface Definition {
  filePath: string;
  name: string;
  itemCount: number;
  testCount: number;
}

export function registerListDefinitions(server: McpServer): void {
  server.tool(
    'list_definitions',
    'Lists all runnable definition files in the .dokkimi/ folder with their name, item count, and test count.',
    {
      projectPath: z
        .string()
        .optional()
        .describe('Path to the project root. Defaults to cwd.'),
    },
    async ({ projectPath }) => {
      const startDir = projectPath || process.cwd();
      const dokkimiDir = findDokkimiDir(startDir);

      if (!dokkimiDir) {
        return {
          content: [
            {
              type: 'text',
              text: 'No .dokkimi/ folder found. Run `dokkimi init` to create one.',
            },
          ],
          isError: true,
        };
      }

      const files = scanFiles(dokkimiDir);
      const definitions: Definition[] = [];

      for (const file of files) {
        try {
          const raw = fs.readFileSync(file, 'utf-8');
          const parsed = parseDefinitionFile(file, raw);
          if (
            parsed &&
            typeof parsed === 'object' &&
            !Array.isArray(parsed) &&
            typeof (parsed as Record<string, unknown>).name === 'string' &&
            Array.isArray((parsed as Record<string, unknown>).items)
          ) {
            const obj = parsed as Record<string, unknown>;
            const tests = Array.isArray(obj.tests) ? obj.tests : [];
            definitions.push({
              filePath: file,
              name: obj.name as string,
              itemCount: (obj.items as unknown[]).length,
              testCount: tests.length,
            });
          }
        } catch {
          // Skip unparseable files
        }
      }

      return {
        content: [
          { type: 'text', text: JSON.stringify({ definitions }, null, 2) },
        ],
      };
    },
  );
}
