import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { trackEvent } from '@dokkimi/telemetry';

function wrapCallback(name: string, cb: (...a: any[]) => Promise<any>) {
  return async (...cbArgs: any[]) => {
    const start = Date.now();
    try {
      const result = await cb(...cbArgs);
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
}

export function withToolTracking(server: McpServer): McpServer {
  const originalTool = server.tool.bind(server);

  server.tool = ((...args: any[]) => {
    const name = args[0] as string;
    args[args.length - 1] = wrapCallback(name, args[args.length - 1]);
    return (originalTool as (...a: any[]) => any)(...args);
  }) as typeof server.tool;

  // Also patch registerTool if it exists (newer MCP SDK versions)
  const srv = server as any;
  if (typeof srv.registerTool === 'function') {
    const originalRegisterTool = srv.registerTool.bind(server);
    srv.registerTool = (...args: any[]) => {
      const name = args[0] as string;
      args[args.length - 1] = wrapCallback(name, args[args.length - 1]);
      return originalRegisterTool(...args);
    };
  }

  return server;
}
