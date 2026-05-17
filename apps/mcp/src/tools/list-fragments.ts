import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  isDefinitionFile,
  parseDefinitionFile,
} from '@dokkimi/definition-validator';

interface Fragment {
  filePath: string;
  type: string;
  name: string;
  description?: string;
}

function findDokkimiDir(startDir: string): string | null {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;

  while (dir !== root) {
    const candidate = path.join(dir, '.dokkimi');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    dir = path.dirname(dir);
  }
  return null;
}

function scanFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...scanFiles(full));
    } else if (isDefinitionFile(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function classifyFragment(
  parsed: Record<string, unknown>,
  filePath: string,
): Fragment | null {
  // Runnable definitions have name + items — they're not fragments
  if (typeof parsed.name === 'string' && Array.isArray(parsed.items)) {
    return null;
  }

  // Shared item fragment: has "type" field (SERVICE, DATABASE, MOCK)
  if (typeof parsed.type === 'string') {
    return {
      filePath,
      type: String(parsed.type).toLowerCase(),
      name:
        typeof parsed.name === 'string'
          ? parsed.name
          : path.basename(filePath, path.extname(filePath)),
      description:
        typeof parsed.description === 'string' ? parsed.description : undefined,
    };
  }

  // Array of steps — likely a shared action ref
  if (Array.isArray(parsed)) {
    return {
      filePath,
      type: 'actions',
      name: path.basename(filePath, path.extname(filePath)),
    };
  }

  return null;
}

export function registerListFragments(server: McpServer): void {
  server.tool(
    'list_fragments',
    'Lists all shared fragment files in the .dokkimi/ folder with their type, name, and description.',
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
      const fragments: Fragment[] = [];

      for (const file of files) {
        try {
          const raw = fs.readFileSync(file, 'utf-8');
          const parsed = parseDefinitionFile(file, raw);
          if (parsed && typeof parsed === 'object') {
            const fragment = classifyFragment(
              parsed as Record<string, unknown>,
              file,
            );
            if (fragment) {
              fragments.push(fragment);
            }
          }
        } catch {
          // Skip unparseable files
        }
      }

      return {
        content: [
          { type: 'text', text: JSON.stringify({ fragments }, null, 2) },
        ],
      };
    },
  );
}
