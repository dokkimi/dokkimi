import * as fs from 'fs';
import * as path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

function loadSpec(): string {
  const candidates = [
    path.join(__dirname, '..', 'dokkimi-instructions.md'),
    path.join(__dirname, '..', '..', 'dokkimi-instructions.md'),
    path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'shared',
      'docs',
      'dokkimi-instructions.md',
    ),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, 'utf-8');
    }
  }
  return 'Dokkimi specification not found.';
}

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
