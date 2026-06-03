jest.mock('../lib/ct-client');

import { ctFetch } from '../lib/ct-client';
import { registerGetTraffic } from './get-traffic';
import { createMockServer, parseContent } from './__helpers__/mock-server';

const mockCtFetch = ctFetch as jest.Mock;

beforeEach(() => {
  mockCtFetch.mockReset();
});

const sampleLogs = [
  {
    method: 'GET',
    url: '/api/users',
    statusCode: 200,
    origin: 'api-gateway',
    target: 'user-service',
    isMocked: false,
    duration: 45,
    requestBody: null,
    responseBody: { users: [] },
    requestHeaders: {},
    responseHeaders: {},
    requestSentAt: '2026-01-01T00:00:01Z',
    responseReceivedAt: '2026-01-01T00:00:01.045Z',
  },
  {
    method: 'POST',
    url: '/api/orders',
    statusCode: 201,
    origin: 'api-gateway',
    target: 'order-service',
    isMocked: true,
    duration: 12,
    requestBody: { item: 'widget' },
    responseBody: { id: 'o1' },
    requestHeaders: {},
    responseHeaders: {},
    requestSentAt: '2026-01-01T00:00:02Z',
    responseReceivedAt: '2026-01-01T00:00:02.012Z',
  },
];

describe('get_traffic', () => {
  it('returns all traffic logs', async () => {
    const { server, call } = createMockServer();
    registerGetTraffic(server);

    mockCtFetch.mockResolvedValue({
      logs: sampleLogs,
      total: 2,
      limit: 500,
      offset: 0,
    });

    const result = await call('get_traffic', { instanceId: 'i1' });
    const data = parseContent(result);

    expect(data.total).toBe(2);
    expect(data.returned).toBe(2);
    expect(data.logs[0].method).toBe('GET');
  });

  it('filters by origin', async () => {
    const { server, call } = createMockServer();
    registerGetTraffic(server);

    mockCtFetch.mockResolvedValue({
      logs: sampleLogs,
      total: 2,
      limit: 500,
      offset: 0,
    });

    const result = await call('get_traffic', {
      instanceId: 'i1',
      origin: 'api-gateway',
    });
    const data = parseContent(result);

    expect(data.returned).toBe(2);
  });

  it('filters by target', async () => {
    const { server, call } = createMockServer();
    registerGetTraffic(server);

    mockCtFetch.mockResolvedValue({
      logs: sampleLogs,
      total: 2,
      limit: 500,
      offset: 0,
    });

    const result = await call('get_traffic', {
      instanceId: 'i1',
      target: 'user-service',
    });
    const data = parseContent(result);

    expect(data.returned).toBe(1);
    expect(data.logs[0].url).toBe('/api/users');
  });

  it('returns error when CT throws', async () => {
    const { server, call } = createMockServer();
    registerGetTraffic(server);

    mockCtFetch.mockRejectedValue(
      new Error('Control Tower returned 404: not found'),
    );

    const result = await call('get_traffic', { instanceId: 'bad-id' });

    expect(result.isError).toBe(true);
    expect(parseContent(result).error).toMatch(/404/);
  });
});
