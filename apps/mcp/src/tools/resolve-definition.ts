import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  resolveDefinitions,
  type ResolverResult,
} from '@dokkimi/definition-resolver';

export function registerResolveDefinition(server: McpServer): void {
  server.tool(
    'resolve_definition',
    'Resolves all $ref references and ${{VAR}} interpolations in a definition file, returning the fully-expanded result.',
    {
      filePath: z.string().describe('Path to a definition file'),
    },
    async ({ filePath }) => {
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
                  resolved: null,
                  errors: [
                    {
                      file: filePath,
                      errors: [e instanceof Error ? e.message : String(e)],
                      warnings: [],
                    },
                  ],
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      const errors = result.errors.filter(
        (e) => e.errors.length > 0 || e.warnings.length > 0,
      );

      if (result.definitions.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  resolved: null,
                  errors:
                    errors.length > 0
                      ? errors
                      : [
                          {
                            file: filePath,
                            errors: ['No definitions found'],
                            warnings: [],
                          },
                        ],
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      const resolved =
        result.definitions.length === 1
          ? result.definitions[0].definition
          : result.definitions.map((d) => ({
              name: d.name,
              definition: d.definition,
            }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ resolved, errors }, null, 2),
          },
        ],
      };
    },
  );
}
