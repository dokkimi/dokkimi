import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ctFetch } from '../lib/ct-client';
import type { HttpLog, PaginatedResponse } from '../lib/ct-types';

export function registerGetTraffic(server: McpServer): void {
  server.tool(
    'get_traffic',
    'Returns HTTP traffic logs captured by the interceptor sidecars for a given instance. Optionally filter by origin (calling service) or target (receiving service) to narrow results.',
    {
      instanceId: z
        .string()
        .describe('Instance ID (from get_run_summary or get_failures)'),
      origin: z
        .string()
        .optional()
        .describe('Filter to requests from this service name'),
      target: z
        .string()
        .optional()
        .describe('Filter to requests targeting this service name'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe('Maximum number of logs to return (default: 500)'),
    },
    async ({ instanceId, origin, target, limit }) => {
      try {
        const response = await ctFetch<PaginatedResponse<HttpLog>>(
          `/logs/http/instance/${instanceId}`,
          { limit: String(limit ?? 500) },
        );

        let logs = response.logs;

        if (origin) {
          logs = logs.filter(
            (l) => l.origin?.toLowerCase() === origin.toLowerCase(),
          );
        }
        if (target) {
          logs = logs.filter(
            (l) => l.target?.toLowerCase() === target.toLowerCase(),
          );
        }

        const result = {
          total: response.total,
          returned: logs.length,
          logs: logs.map((l) => ({
            method: l.method,
            url: l.url,
            statusCode: l.statusCode,
            origin: l.origin,
            target: l.target,
            isMocked: l.isMocked,
            duration: l.duration,
            requestBody: l.requestBody,
            responseBody: l.responseBody,
            requestHeaders: l.requestHeaders,
            responseHeaders: l.responseHeaders,
            requestSentAt: l.requestSentAt,
            responseReceivedAt: l.responseReceivedAt,
          })),
        };

        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  error:
                    err instanceof Error
                      ? err.message
                      : 'Failed to fetch traffic logs',
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
