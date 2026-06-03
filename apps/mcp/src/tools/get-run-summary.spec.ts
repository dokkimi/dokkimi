jest.mock('../lib/ct-client');
jest.mock('../lib/dokkimi-dir', () => ({
  findDokkimiDir: () => '/project/.dokkimi',
}));

import { ctFetchOrNull } from '../lib/ct-client';
import { registerGetRunSummary } from './get-run-summary';
import { createMockServer, parseContent } from './__helpers__/mock-server';

const mockCtFetchOrNull = ctFetchOrNull as jest.Mock;

beforeEach(() => {
  mockCtFetchOrNull.mockReset();
});

describe('get_run_summary', () => {
  it('returns run summary with instance counts', async () => {
    const { server, call } = createMockServer();
    registerGetRunSummary(server);

    mockCtFetchOrNull.mockResolvedValue({
      runId: 'run-1',
      status: 'COMPLETED',
      createdAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:05:00Z',
      instances: [
        { id: 'i1', name: 'test-a', status: 'STOPPED', testStatus: 'PASSED' },
        { id: 'i2', name: 'test-b', status: 'STOPPED', testStatus: 'FAILED' },
        { id: 'i3', name: 'test-c', status: 'SKIPPED' },
      ],
    });

    const result = await call('get_run_summary');
    const data = parseContent(result);

    expect(data.runId).toBe('run-1');
    expect(data.summary).toEqual({
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
    });
    expect(data.instances).toHaveLength(3);
  });

  it('passes projectPath to ctFetchOrNull', async () => {
    const { server, call } = createMockServer();
    registerGetRunSummary(server);

    mockCtFetchOrNull.mockResolvedValue(null);

    await call('get_run_summary');

    expect(mockCtFetchOrNull).toHaveBeenCalledWith('/runs/latest', {
      projectPath: '/project',
    });
  });

  it('returns error when no run exists', async () => {
    const { server, call } = createMockServer();
    registerGetRunSummary(server);

    mockCtFetchOrNull.mockResolvedValue(null);

    const result = await call('get_run_summary');
    const data = parseContent(result);

    expect(result.isError).toBe(true);
    expect(data.error).toMatch(/No run found/);
  });

  it('returns error when CT throws', async () => {
    const { server, call } = createMockServer();
    registerGetRunSummary(server);

    mockCtFetchOrNull.mockRejectedValue(
      new Error('Control Tower returned 500: Internal Server Error'),
    );

    const result = await call('get_run_summary');
    const data = parseContent(result);

    expect(result.isError).toBe(true);
    expect(data.error).toMatch(/500/);
  });
});
