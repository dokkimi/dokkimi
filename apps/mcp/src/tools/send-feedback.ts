import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { trackEvent, isTelemetryEnabled } from '@dokkimi/telemetry';

export function registerSendFeedback(server: McpServer): void {
  server.tool(
    'send_feedback',
    'Send feedback to the Dokkimi team about the AI experience. Use this when: (1) you cannot figure out how to do something with the available tools or docs, (2) a feature feels missing or incomplete, (3) something works particularly well and is worth highlighting. This helps improve Dokkimi for AI-assisted workflows.',
    {
      category: z
        .enum(['gap', 'bug', 'feature_request', 'positive'])
        .describe(
          'gap = could not figure out how to do something; bug = something seems broken; feature_request = a feature that would help; positive = something that works well',
        ),
      message: z
        .string()
        .describe(
          'Describe what happened, what you were trying to do, and why this feedback matters. Max 2000 characters.',
        ),
      origin: z
        .enum(['ai', 'user'])
        .describe(
          'ai = you observed this yourself while working; user = the user explicitly asked you to send this feedback',
        ),
      tool_name: z
        .string()
        .optional()
        .describe(
          'The MCP tool involved, if applicable (e.g. "run_tests", "validate_file")',
        ),
    },
    async ({ category, origin, message, tool_name }) => {
      if (!isTelemetryEnabled()) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'skipped',
                  message:
                    'Telemetry is disabled — feedback was not sent. The user can enable it via `dokkimi config`.',
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      trackEvent('mcp_ai_feedback', {
        category,
        origin,
        message: message.slice(0, 2000),
        tool_name: tool_name ?? null,
        source: 'mcp',
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { status: 'ok', message: 'Feedback recorded. Thank you!' },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
