import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadSpec } from '../lib/load-spec.js';

const TOPIC_SECTIONS: Record<string, string[]> = {
  service: ['## Item Types', '### SERVICE'],
  database: ['## Item Types', '### DATABASE'],
  mock: ['## Item Types', '### MOCK'],
  tests: ['## Tests'],
  assertions: [
    '## Tests',
    '### Assertion Blocks',
    '### Assertion Paths',
    '### Assertion Operators',
  ],
  variables: ['## Config File', '## Tests', '### Variable Interpolation'],
  ui: ['## Tests', '### Step Actions'],
  config: ['## Config'],
  ref: ['## $ref (Item References)', '## $ref (Action References)'],
};

function extractSection(spec: string, heading: string): string {
  const level = heading.match(/^#+/)![0].length;
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(${escapedHeading}\\b[^\\n]*\\n)([\\s\\S]*?)(?=\\n#{1,${level}} [^#]|$)`,
  );
  const match = spec.match(pattern);
  return match ? match[1] + match[2] : '';
}

function extractTopic(spec: string, topic: string): string {
  const headings = TOPIC_SECTIONS[topic];
  if (!headings) {
    return '';
  }

  const sections: string[] = [];
  for (const heading of headings) {
    const section = extractSection(spec, heading);
    if (section) {
      sections.push(section.trim());
    }
  }
  return sections.join('\n\n');
}

export function registerGetReference(server: McpServer): void {
  server.tool(
    'get_reference',
    'Returns the relevant section of the Dokkimi specification. Call this before writing any definition file.',
    {
      topic: z
        .enum([
          'service',
          'database',
          'mock',
          'tests',
          'assertions',
          'variables',
          'ui',
          'config',
          'ref',
          'all',
        ])
        .optional()
        .describe('Topic to retrieve. Omit or use "all" for the full spec.'),
    },
    async ({ topic }) => {
      const spec = loadSpec();

      if (!topic || topic === 'all') {
        return { content: [{ type: 'text', text: spec }] };
      }

      const content = extractTopic(spec, topic);
      if (!content) {
        return {
          content: [
            {
              type: 'text',
              text: `No section found for topic "${topic}". Available topics: ${Object.keys(TOPIC_SECTIONS).join(', ')}`,
            },
          ],
          isError: true,
        };
      }

      return { content: [{ type: 'text', text: content }] };
    },
  );
}
