import type { RunStatusInstance, RunStatusResponse } from './run-display';

// ---------------------------------------------------------------------------
// Mocks — must be declared before import so Jest hoists them
// ---------------------------------------------------------------------------

jest.mock('./cli-utils', () => ({
  fetchJson: jest.fn(),
  sleep: jest.fn(() => Promise.resolve()),
}));

jest.mock('./formatting', () => ({
  formatDuration: jest.fn((ms: number) => `${ms}ms`),
}));

import { pollForCompletionCI } from './ci-display';
import { fetchJson, sleep } from './cli-utils';

const mockFetchJson = fetchJson as jest.MockedFunction<typeof fetchJson>;
const mockSleep = sleep as jest.MockedFunction<typeof sleep>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inst(
  id: string,
  name: string,
  status: string,
  testStatus?: string,
  errorMessage?: string,
): RunStatusInstance {
  return { id, name, status, testStatus, errorMessage };
}

function statusResponse(
  runStatus: string,
  instances: RunStatusInstance[],
): RunStatusResponse {
  return { runId: 'run-1', status: runStatus, instances };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pollForCompletionCI', () => {
  let logSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    jest.clearAllMocks();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('returns passed=true when all instances COMPLETED', async () => {
    mockFetchJson.mockResolvedValueOnce(
      statusResponse('COMPLETED', [
        inst('i1', 'svc-a', 'COMPLETED'),
        inst('i2', 'svc-b', 'PASSED'),
      ]),
    );

    const result = await pollForCompletionCI('http://ct', 'run-1');

    expect(result.passed).toBe(true);
    expect(result.runId).toBe('run-1');
    expect(result.instances).toHaveLength(2);
  });

  it('returns passed=false when any instance FAILED', async () => {
    mockFetchJson.mockResolvedValueOnce(
      statusResponse('FAILED', [
        inst('i1', 'svc-a', 'PASSED'),
        inst('i2', 'svc-b', 'FAILED', undefined, 'assertion failed'),
      ]),
    );

    // printFailureDetails will call fetchJson twice (assertions + execLogs)
    mockFetchJson.mockResolvedValueOnce([]); // assertions
    mockFetchJson.mockResolvedValueOnce({ logs: [], total: 0 }); // exec logs

    const result = await pollForCompletionCI('http://ct', 'run-1');

    expect(result.passed).toBe(false);
  });

  it('prints per-instance results with [Dokkimi] prefix', async () => {
    mockFetchJson.mockResolvedValueOnce(
      statusResponse('COMPLETED', [
        inst('i1', 'svc-a', 'PASSED'),
        inst('i2', 'svc-b', 'COMPLETED'),
      ]),
    );

    await pollForCompletionCI('http://ct', 'run-1');

    const allOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allOutput).toContain('[Dokkimi]');
    expect(allOutput).toContain('svc-a');
    expect(allOutput).toContain('svc-b');
  });

  it('prints failure details for failed instances', async () => {
    mockFetchJson.mockResolvedValueOnce(
      statusResponse('FAILED', [
        inst('i1', 'svc-fail', 'FAILED', undefined, 'test timed out'),
      ]),
    );

    // printFailureDetails: assertions with a failure
    mockFetchJson.mockResolvedValueOnce([
      {
        id: 'a1',
        instanceId: 'i1',
        stepIndex: 0,
        assertionIndex: 0,
        assertionType: 'response.statusCode',
        passed: false,
        expected: 200,
        actual: 500,
        error: null,
        path: 'statusCode',
        operator: 'equals',
        blockIndex: 0,
        resultKind: null,
      },
    ]);
    mockFetchJson.mockResolvedValueOnce({ logs: [], total: 0 }); // exec logs

    await pollForCompletionCI('http://ct', 'run-1');

    const allOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allOutput).toContain('test timed out');
    expect(allOutput).toContain('expected');
    expect(allOutput).toContain('200');
    expect(allOutput).toContain('received');
    expect(allOutput).toContain('500');
  });

  it('enforces timeout and returns passed=false', async () => {
    // Never return a terminal status — let the timeout trigger
    const _nowOriginal = Date.now;
    let callCount = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => {
      callCount++;
      // First call (runStart) returns 0, subsequent calls return past the timeout
      if (callCount <= 1) {
        return 0;
      }
      return 6000;
    });

    mockFetchJson.mockResolvedValue(
      statusResponse('RUNNING', [inst('i1', 'svc-a', 'RUNNING')]),
    );

    const result = await pollForCompletionCI(
      'http://ct',
      'run-1',
      undefined,
      undefined,
      5000,
    );

    expect(result.passed).toBe(false);

    const allOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allOutput).toContain('Timed out');

    jest.spyOn(Date, 'now').mockRestore();
  });

  it('handles abort signal', async () => {
    const abort = new AbortController();
    abort.abort();

    const result = await pollForCompletionCI('http://ct', 'run-1', abort);

    expect(result.passed).toBe(false);
    // fetchJson should never have been called since we aborted immediately
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it('includes skipped instances in results', async () => {
    const skippedInst = inst('s1', 'skipped-svc', 'SKIPPED');

    mockFetchJson.mockResolvedValueOnce(
      statusResponse('COMPLETED', [inst('i1', 'svc-a', 'PASSED')]),
    );

    const result = await pollForCompletionCI('http://ct', 'run-1', undefined, [
      skippedInst,
    ]);

    expect(result.passed).toBe(true);
    // Skipped instance should appear in allInstances output
    expect(result.instances).toHaveLength(2);
    expect(result.instances.some((i) => i.name === 'skipped-svc')).toBe(true);

    const allOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allOutput).toContain('skipped-svc');
  });

  it('polls multiple times until terminal status', async () => {
    mockFetchJson
      .mockResolvedValueOnce(
        statusResponse('RUNNING', [inst('i1', 'svc-a', 'RUNNING')]),
      )
      .mockResolvedValueOnce(
        statusResponse('RUNNING', [inst('i1', 'svc-a', 'RUNNING')]),
      )
      .mockResolvedValueOnce(
        statusResponse('COMPLETED', [inst('i1', 'svc-a', 'PASSED')]),
      );

    const result = await pollForCompletionCI('http://ct', 'run-1');

    expect(result.passed).toBe(true);
    expect(mockSleep).toHaveBeenCalledTimes(2);
    expect(mockSleep).toHaveBeenCalledWith(2000);
  });

  it('prints summary with passed/failed counts', async () => {
    mockFetchJson.mockResolvedValueOnce(
      statusResponse('FAILED', [
        inst('i1', 'svc-a', 'PASSED'),
        inst('i2', 'svc-b', 'FAILED'),
      ]),
    );
    mockFetchJson.mockResolvedValueOnce([]); // assertions for svc-b
    mockFetchJson.mockResolvedValueOnce({ logs: [], total: 0 }); // exec logs

    await pollForCompletionCI('http://ct', 'run-1');

    const allOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allOutput).toContain('1 passed');
    expect(allOutput).toContain('1 failed');
    expect(allOutput).toContain('svc-b');
  });
});
