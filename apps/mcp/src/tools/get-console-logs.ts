import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ctFetch } from '../lib/ct-client';
import type {
  ConsoleLog,
  PaginatedResponse,
  InstanceDetail,
} from '../lib/ct-types';

export function registerGetConsoleLogs(server: McpServer): void {
  server.tool(
    'get_console_logs',
    'Returns console output (stdout/stderr) from services in a given instance. Optionally filter by service name to see logs from a specific service.',
    {
      instanceId: z
        .string()
        .describe('Instance ID (from get_run_summary or get_failures)'),
      service: z
        .string()
        .optional()
        .describe('Service name to filter logs for (e.g. "api-gateway")'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe('Maximum number of logs to return (default: 1000)'),
    },
    async ({ instanceId, service, limit }) => {
      const params: Record<string, string | undefined> = {
        limit: String(limit ?? 1000),
      };

      if (service) {
        const instance = await ctFetch<InstanceDetail>(
          `/namespaces/instances/${instanceId}`,
        );
        const item = instance.items.find(
          (i) => i.itemDefinitionName.toLowerCase() === service.toLowerCase(),
        );
        if (!item) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    error: `Service "${service}" not found in instance. Available: ${instance.items.map((i) => i.itemDefinitionName).join(', ')}`,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
        params.instanceItemId = item.id;
      }

      const response = await ctFetch<PaginatedResponse<ConsoleLog>>(
        `/logs/console/instance/${instanceId}`,
        params,
      );

      const result = {
        total: response.total,
        returned: response.logs.length,
        logs: response.logs.map((l) => ({
          level: l.level,
          message: l.message,
          timestamp: l.timestamp,
        })),
      };

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );
}
