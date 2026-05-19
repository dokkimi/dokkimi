import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  resolveDefinitions,
  type ResolverResult,
} from '@dokkimi/definition-resolver';

export function registerValidateFile(server: McpServer): void {
  server.tool(
    'validate_file',
    'Validates definition file(s) and returns structured errors/warnings. Fast, no-network check. Accepts a single file, a folder, or a pattern.',
    {
      target: z
        .string()
        .describe(
          'Path to a definition file (.json, .yml, .yaml), a folder containing definitions, or a pattern.',
        ),
    },
    async ({ target: filePath }) => {
      let result: ResolverResult;
      try {
        result = resolveDefinitions(filePath);
      } catch (e) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  valid: false,
                  errors: [
                    {
                      message: e instanceof Error ? e.message : String(e),
                      path: filePath,
                    },
                  ],
                  warnings: [],
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      const errors: { message: string; path: string }[] = [];
      const warnings: { message: string; path: string }[] = [];

      for (const e of result.errors) {
        for (const msg of e.errors) {
          errors.push({ message: msg, path: e.file });
        }
        for (const msg of e.warnings) {
          warnings.push({ message: msg, path: e.file });
        }
      }

      const valid = errors.length === 0;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ valid, errors, warnings }, null, 2),
          },
        ],
      };
    },
  );
}
