type ToolCallback = (...args: any[]) => Promise<any>;

export interface MockServer {
  server: any;
  call: (name: string, params?: Record<string, any>) => Promise<any>;
}

export function createMockServer(): MockServer {
  const tools: Record<string, ToolCallback> = {};

  const server = {
    tool: jest.fn((...args: any[]) => {
      const name = args[0] as string;
      tools[name] = args[args.length - 1];
    }),
  };

  const call = async (name: string, params: Record<string, any> = {}) => {
    const cb = tools[name];
    if (!cb) {
      throw new Error(`Tool "${name}" not registered`);
    }
    return cb(params, { sendNotification: jest.fn() });
  };

  return { server, call };
}

export function parseContent(result: any): any {
  return JSON.parse(result.content[0].text);
}
