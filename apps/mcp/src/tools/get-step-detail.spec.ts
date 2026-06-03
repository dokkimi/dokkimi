jest.mock('../lib/ct-client');

import { ctFetch } from '../lib/ct-client';
import { registerGetStepDetail } from './get-step-detail';
import { createMockServer, parseContent } from './__helpers__/mock-server';

const mockCtFetch = ctFetch as jest.Mock;

beforeEach(() => {
  mockCtFetch.mockReset();
});

describe('get_step_detail', () => {
  it('returns execution logs and assertions for the given step', async () => {
    const { server, call } = createMockServer();
    registerGetStepDetail(server);

    mockCtFetch
      .mockResolvedValueOnce({
        logs: [
          {
            stepIndex: 0,
            eventType: 'action',
            message: 'GET /api',
            actionType: 'http_request',
            selector: null,
            duration: 120,
            error: null,
            errorType: null,
            variables: {},
            timestamp: '2026-01-01T00:00:01Z',
          },
          {
            stepIndex: 1,
            eventType: 'action',
            message: 'POST /api',
            actionType: 'http_request',
            selector: null,
            duration: 200,
            error: null,
            errorType: null,
            variables: {},
            timestamp: '2026-01-01T00:00:02Z',
          },
        ],
        total: 2,
        limit: 100,
        offset: 0,
      })
      .mockResolvedValueOnce([
        {
          stepIndex: 0,
          blockIndex: 0,
          assertionIndex: 0,
          passed: true,
          path: 'status',
          operator: 'eq',
          expected: 200,
          actual: 200,
          error: null,
          resultKind: null,
        },
        {
          stepIndex: 1,
          blockIndex: 0,
          assertionIndex: 0,
          passed: false,
          path: 'status',
          operator: 'eq',
          expected: 201,
          actual: 500,
          error: null,
          resultKind: null,
        },
      ]);

    const result = await call('get_step_detail', {
      instanceId: 'i1',
      stepIndex: 0,
    });
    const data = parseContent(result);

    expect(data.stepIndex).toBe(0);
    expect(data.executionLogs).toHaveLength(1);
    expect(data.executionLogs[0].message).toBe('GET /api');
    expect(data.assertions).toHaveLength(1);
    expect(data.assertions[0].passed).toBe(true);
  });

  it('returns error when CT is unreachable', async () => {
    const { server, call } = createMockServer();
    registerGetStepDetail(server);

    mockCtFetch.mockRejectedValue(
      new Error(
        'Control Tower is not running. Start Dokkimi with `dokkimi status` first.',
      ),
    );

    const result = await call('get_step_detail', {
      instanceId: 'i1',
      stepIndex: 0,
    });

    expect(result.isError).toBe(true);
    expect(parseContent(result).error).toMatch(/not running/);
  });
});
