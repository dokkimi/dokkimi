import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadSpec } from '../lib/load-spec';

// Each topic is a list of headings from dokkimi-instructions.md. A heading
// followed in the list by a deeper one (## Item Types, then ### SERVICE) gives
// only its introduction, the text before its first subsection.
const TOPIC_SECTIONS: Record<string, string[]> = {
  service: ['## Item Types', '### SERVICE'],
  worker: ['## Item Types', '### WORKER'],
  database: ['## Item Types', '### DATABASE'],
  mock: ['## Item Types', '### MOCK'],
  broker: ['## Item Types', '### BROKER'],
  tests: ['## Tests'],
  assertions: [
    '## Tests',
    '### Assertion Blocks',
    '### Assertion Paths',
    '### Assertion Operators',
  ],
  loops: ['## Tests', '### Loops'],
  variables: ['## Config File', '## Tests', '### Variable Interpolation'],
  ui: ['## Tests', '### Step Actions'],
  config: ['## Config'],
  ref: ['## $ref (Item References)', '## $ref (Action References)'],
  examples: [
    '## Best Practices (IMPORTANT)',
    '## Two File Types (Shape Detection)',
    '## Complete Example',
  ],
};

const headingLevel = (heading: string): number =>
  heading.match(/^#+/)?.[0].length ?? 0;

/**
 * Returns the section under a heading that matches exactly, up to the next
 * heading of the same or a higher level, or (introOnly) up to the next heading
 * of any level. Lines inside fenced code blocks are never headings, so a "#"
 * comment in an example doesn't end the section.
 */
function extractSection(
  spec: string,
  heading: string,
  introOnly: boolean,
): string {
  const level = headingLevel(heading);
  const lines = spec.split('\n');
  let inFence = false;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !/^#{1,6} /.test(line)) {
      continue;
    }
    if (start < 0) {
      if (line.trim() === heading) {
        start = i;
      }
      continue;
    }
    if (introOnly || headingLevel(line) <= level) {
      end = i;
      break;
    }
  }
  return start < 0 ? '' : lines.slice(start, end).join('\n').trim();
}

export function extractTopic(spec: string, topic: string): string {
  const headings = TOPIC_SECTIONS[topic];
  if (!headings) {
    return '';
  }

  const sections: string[] = [];
  headings.forEach((heading, i) => {
    const next = headings[i + 1];
    const introOnly =
      next !== undefined && headingLevel(next) > headingLevel(heading);
    const section = extractSection(spec, heading, introOnly);
    if (section) {
      sections.push(section);
    }
  });
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
          'worker',
          'mock',
          'broker',
          'tests',
          'assertions',
          'loops',
          'variables',
          'ui',
          'config',
          'ref',
          'examples',
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
