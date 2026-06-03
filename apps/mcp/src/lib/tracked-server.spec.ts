jest.mock('@dokkimi/telemetry', () => ({
  trackEvent: jest.fn(),
}));

import { trackEvent } from '@dokkimi/telemetry';
import { withToolTracking } from './tracked-server';

const mockTrackEvent = trackEvent as jest.Mock;

function createMockServer() {
  const registeredTools: Record<string, (...a: any[]) => Promise<any>> = {};

  const server: any = {
    tool: jest.fn((...args: any[]) => {
      const name = args[0] as string;
      const cb = args[args.length - 1];
      registeredTools[name] = cb;
    }),
  };

  return { server, registeredTools };
}

beforeEach(() => {
  mockTrackEvent.mockClear();
});

describe('withToolTracking', () => {
  it('tracks successful tool calls', async () => {
    const { server, registeredTools } = createMockServer();
    withToolTracking(server);

    server.tool('my_tool', 'desc', {}, async () => ({ content: [] }));

    const result = await registeredTools['my_tool']();
    expect(result).toEqual({ content: [] });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'mcp_tool_call',
      expect.objectContaining({
        tool_name: 'my_tool',
        success: true,
        duration_ms: expect.any(Number),
      }),
    );
  });

  it('tracks failed tool calls and re-throws', async () => {
    const { server, registeredTools } = createMockServer();
    withToolTracking(server);

    server.tool('fail_tool', 'desc', {}, async () => {
      throw new Error('boom');
    });

    await expect(registeredTools['fail_tool']()).rejects.toThrow('boom');
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'mcp_tool_call',
      expect.objectContaining({
        tool_name: 'fail_tool',
        success: false,
        error_type: 'Error',
      }),
    );
  });

  it('patches registerTool if present', async () => {
    const registeredTools: Record<string, (...a: any[]) => Promise<any>> = {};

    const server: any = {
      tool: jest.fn(),
      registerTool: jest.fn((...args: any[]) => {
        const name = args[0] as string;
        registeredTools[name] = args[args.length - 1];
      }),
    };

    withToolTracking(server);
    server.registerTool('reg_tool', 'desc', {}, async () => ({
      content: [],
    }));

    await registeredTools['reg_tool']();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'mcp_tool_call',
      expect.objectContaining({ tool_name: 'reg_tool', success: true }),
    );
  });

  it('does not fail if registerTool is absent', () => {
    const { server } = createMockServer();
    expect(() => withToolTracking(server)).not.toThrow();
  });
});
