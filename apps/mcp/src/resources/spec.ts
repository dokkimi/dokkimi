import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadSpec } from '../lib/load-spec.js';

export function registerSpecResource(server: McpServer): void {
  server.resource(
    'spec',
    'dokkimi://spec',
    {
      description:
        'The full Dokkimi specification. Prefer the get_reference tool for scoped lookups.',
      mimeType: 'text/markdown',
    },
    async () => ({
      contents: [
        {
          uri: 'dokkimi://spec',
          mimeType: 'text/markdown',
          text: loadSpec(),
        },
      ],
    }),
  );
}
