import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ctFetch } from '../lib/ct-client';
import type { DatabaseLog, PaginatedResponse } from '../lib/ct-types';

export function registerGetDbLogs(server: McpServer): void {
  server.tool(
    'get_db_logs',
    'Returns database query logs captured by the DB proxy sidecars for a given instance. Shows queries, parameters, results, duration, and any errors.',
    {
      instanceId: z
        .string()
        .describe('Instance ID (from get_run_summary or get_failures)'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe('Maximum number of logs to return (default: 500)'),
    },
    async ({ instanceId, limit }) => {
      const response = await ctFetch<PaginatedResponse<DatabaseLog>>(
        `/logs/database/instance/${instanceId}`,
        { limit: String(limit ?? 500) },
      );

      const result = {
        total: response.total,
        returned: response.logs.length,
        logs: response.logs.map((l) => ({
          databaseType: l.databaseType,
          databaseName: l.databaseName,
          query: l.query,
          params: l.params,
          success: l.success,
          data: l.data,
          rowsAffected: l.rowsAffected,
          error: l.error,
          duration: l.duration,
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
