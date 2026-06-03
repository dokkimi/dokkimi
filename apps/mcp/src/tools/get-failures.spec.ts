jest.mock('../lib/ct-client');
jest.mock('../lib/dokkimi-dir', () => ({
  findDokkimiDir: () => '/project/.dokkimi',
}));

import { ctFetch, ctFetchOrNull } from '../lib/ct-client';
import { registerGetFailures } from './get-failures';
import { createMockServer, parseContent } from './__helpers__/mock-server';

const mockCtFetch = ctFetch as jest.Mock;
const mockCtFetchOrNull = ctFetchOrNull as jest.Mock;

beforeEach(() => {
  mockCtFetch.mockReset();
  mockCtFetchOrNull.mockReset();
});

describe('get_failures', () => {
  it('returns failed assertions for all failed instances', async () => {
    const { server, call } = createMockServer();
    registerGetFailures(server);

    mockCtFetchOrNull.mockResolvedValue({
      runId: 'run-1',
      status: 'COMPLETED',
      instances: [
        { id: 'i1', name: 'test-a', status: 'STOPPED', testStatus: 'PASSED' },
        {
          id: 'i2',
          name: 'test-b',
          status: 'STOPPED',
          testStatus: 'FAILED',
          errorMessage: 'assertion failed',
        },
      ],
    });

    mockCtFetch.mockResolvedValue([
      {
        id: 'a1',
        instanceId: 'i2',
        stepIndex: 0,
        assertionIndex: 0,
        passed: false,
        expected: 200,
        actual: 500,
        path: 'status',
        operator: 'eq',
        blockIndex: 0,
        error: null,
        assertionType: 'response',
        resultKind: null,
      },
      {
        id: 'a2',
        instanceId: 'i2',
        stepIndex: 0,
        assertionIndex: 1,
        passed: true,
        expected: 'ok',
        actual: 'ok',
        path: 'body.status',
        operator: 'eq',
        blockIndex: 0,
        error: null,
        assertionType: 'response',
        resultKind: null,
      },
    ]);

    const result = await call('get_failures');
    const data = parseContent(result);

    expect(data).toHaveLength(1);
    expect(data[0].instanceName).toBe('test-b');
    expect(data[0].failedAssertions).toHaveLength(1);
    expect(data[0].failedAssertions[0].expected).toBe(200);
    expect(data[0].failedAssertions[0].actual).toBe(500);
  });

  it('fetches failures for a specific instanceId', async () => {
    const { server, call } = createMockServer();
    registerGetFailures(server);

    mockCtFetch.mockResolvedValue([
      {
        id: 'a1',
        instanceId: 'i5',
        stepIndex: 1,
        assertionIndex: 0,
        passed: false,
        expected: true,
        actual: false,
        path: 'visible',
        operator: 'eq',
        blockIndex: null,
        error: null,
        assertionType: 'response',
        resultKind: null,
      },
    ]);

    const result = await call('get_failures', { instanceId: 'i5' });
    const data = parseContent(result);

    expect(data).toHaveLength(1);
    expect(data[0].instanceId).toBe('i5');
    expect(mockCtFetchOrNull).not.toHaveBeenCalled();
  });

  it('returns all-passed message when no failures', async () => {
    const { server, call } = createMockServer();
    registerGetFailures(server);

    mockCtFetchOrNull.mockResolvedValue({
      runId: 'run-1',
      status: 'COMPLETED',
      instances: [
        { id: 'i1', name: 'test-a', status: 'STOPPED', testStatus: 'PASSED' },
      ],
    });

    const result = await call('get_failures');
    const data = parseContent(result);

    expect(result.isError).toBeUndefined();
    expect(data.message).toMatch(/All tests passed/);
  });

  it('returns error when no run exists', async () => {
    const { server, call } = createMockServer();
    registerGetFailures(server);

    mockCtFetchOrNull.mockResolvedValue(null);

    const result = await call('get_failures');

    expect(result.isError).toBe(true);
    expect(parseContent(result).error).toMatch(/No run found/);
  });

  it('returns error when CT throws', async () => {
    const { server, call } = createMockServer();
    registerGetFailures(server);

    mockCtFetchOrNull.mockRejectedValue(
      new Error('Control Tower returned 500: oops'),
    );

    const result = await call('get_failures');

    expect(result.isError).toBe(true);
    expect(parseContent(result).error).toMatch(/500/);
  });
});
