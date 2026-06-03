jest.mock('../lib/ct-client');

import { ctFetch } from '../lib/ct-client';
import { registerGetConsoleLogs } from './get-console-logs';
import { createMockServer, parseContent } from './__helpers__/mock-server';

const mockCtFetch = ctFetch as jest.Mock;

beforeEach(() => {
  mockCtFetch.mockReset();
});

describe('get_console_logs', () => {
  it('returns console logs for an instance', async () => {
    const { server, call } = createMockServer();
    registerGetConsoleLogs(server);

    mockCtFetch.mockResolvedValue({
      logs: [
        {
          level: 'info',
          message: 'Server started',
          timestamp: '2026-01-01T00:00:01Z',
        },
        {
          level: 'error',
          message: 'Connection refused',
          timestamp: '2026-01-01T00:00:02Z',
        },
      ],
      total: 2,
      limit: 1000,
      offset: 0,
    });

    const result = await call('get_console_logs', { instanceId: 'i1' });
    const data = parseContent(result);

    expect(data.total).toBe(2);
    expect(data.returned).toBe(2);
    expect(data.logs[0].level).toBe('info');
    expect(data.logs[1].message).toBe('Connection refused');
  });

  it('filters by service name', async () => {
    const { server, call } = createMockServer();
    registerGetConsoleLogs(server);

    mockCtFetch
      .mockResolvedValueOnce({
        items: [
          {
            id: 'item-1',
            itemDefinitionName: 'api-gateway',
            status: 'RUNNING',
            readinessStatus: 'READY',
          },
          {
            id: 'item-2',
            itemDefinitionName: 'user-service',
            status: 'RUNNING',
            readinessStatus: 'READY',
          },
        ],
      })
      .mockResolvedValueOnce({
        logs: [
          {
            level: 'info',
            message: 'filtered',
            timestamp: '2026-01-01T00:00:01Z',
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });

    const result = await call('get_console_logs', {
      instanceId: 'i1',
      service: 'api-gateway',
    });
    const data = parseContent(result);

    expect(data.returned).toBe(1);
    const logsFetchCall = mockCtFetch.mock.calls[1];
    expect(logsFetchCall[1]).toEqual(
      expect.objectContaining({ instanceItemId: 'item-1' }),
    );
  });

  it('returns error for unknown service name', async () => {
    const { server, call } = createMockServer();
    registerGetConsoleLogs(server);

    mockCtFetch.mockResolvedValueOnce({
      items: [
        {
          id: 'item-1',
          itemDefinitionName: 'api-gateway',
          status: 'RUNNING',
          readinessStatus: 'READY',
        },
      ],
    });

    const result = await call('get_console_logs', {
      instanceId: 'i1',
      service: 'nonexistent',
    });

    expect(result.isError).toBe(true);
    expect(parseContent(result).error).toMatch(/not found/);
  });

  it('returns error when CT throws', async () => {
    const { server, call } = createMockServer();
    registerGetConsoleLogs(server);

    mockCtFetch.mockRejectedValue(
      new Error(
        'Control Tower is not running. Start Dokkimi with `dokkimi status` first.',
      ),
    );

    const result = await call('get_console_logs', { instanceId: 'i1' });

    expect(result.isError).toBe(true);
    expect(parseContent(result).error).toMatch(/not running/);
  });
});
