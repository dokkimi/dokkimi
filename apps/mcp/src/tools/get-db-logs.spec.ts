jest.mock('../lib/ct-client');

import { ctFetch } from '../lib/ct-client';
import { registerGetDbLogs } from './get-db-logs';
import { createMockServer, parseContent } from './__helpers__/mock-server';

const mockCtFetch = ctFetch as jest.Mock;

beforeEach(() => {
  mockCtFetch.mockReset();
});

describe('get_db_logs', () => {
  it('returns database logs for an instance', async () => {
    const { server, call } = createMockServer();
    registerGetDbLogs(server);

    mockCtFetch.mockResolvedValue({
      logs: [
        {
          databaseType: 'postgres',
          databaseName: 'mydb',
          query: 'SELECT * FROM users',
          params: null,
          success: true,
          data: [{ id: 1, name: 'Alice' }],
          rowsAffected: null,
          error: null,
          duration: 5,
          timestamp: '2026-01-01T00:00:01Z',
        },
      ],
      total: 1,
      limit: 500,
      offset: 0,
    });

    const result = await call('get_db_logs', { instanceId: 'i1' });
    const data = parseContent(result);

    expect(data.total).toBe(1);
    expect(data.logs[0].query).toBe('SELECT * FROM users');
    expect(data.logs[0].databaseType).toBe('postgres');
  });

  it('passes limit parameter', async () => {
    const { server, call } = createMockServer();
    registerGetDbLogs(server);

    mockCtFetch.mockResolvedValue({ logs: [], total: 0, limit: 100, offset: 0 });

    await call('get_db_logs', { instanceId: 'i1', limit: 100 });

    expect(mockCtFetch).toHaveBeenCalledWith(
      '/logs/database/instance/i1',
      { limit: '100' },
    );
  });

  it('defaults limit to 500', async () => {
    const { server, call } = createMockServer();
    registerGetDbLogs(server);

    mockCtFetch.mockResolvedValue({ logs: [], total: 0, limit: 500, offset: 0 });

    await call('get_db_logs', { instanceId: 'i1' });

    expect(mockCtFetch).toHaveBeenCalledWith(
      '/logs/database/instance/i1',
      { limit: '500' },
    );
  });

  it('returns error when CT throws', async () => {
    const { server, call } = createMockServer();
    registerGetDbLogs(server);

    mockCtFetch.mockRejectedValue(new Error('Control Tower returned 500: boom'));

    const result = await call('get_db_logs', { instanceId: 'i1' });

    expect(result.isError).toBe(true);
    expect(parseContent(result).error).toMatch(/500/);
  });
});
