import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { trackEvent } from '@dokkimi/telemetry';

export function withToolTracking(server: McpServer): McpServer {
  const originalTool = server.tool.bind(server);

  server.tool = ((...args: any[]) => {
    const name = args[0] as string;
    const originalCb = args[args.length - 1] as (
      ...cbArgs: any[]
    ) => Promise<any>;

    args[args.length - 1] = async (...cbArgs: any[]) => {
      const start = Date.now();
      try {
        const result = await originalCb(...cbArgs);
        trackEvent('mcp_tool_call', {
          tool_name: name,
          duration_ms: Date.now() - start,
          success: true,
        });
        return result;
      } catch (err) {
        trackEvent('mcp_tool_call', {
          tool_name: name,
          duration_ms: Date.now() - start,
          success: false,
          error_type: err instanceof Error ? err.constructor.name : 'Unknown',
        });
        throw err;
      }
    };

    return (originalTool as (...a: any[]) => any)(...args);
  }) as typeof server.tool;

  return server;
}
