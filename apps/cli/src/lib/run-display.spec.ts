jest.mock('./cli-utils', () => ({
  fetchJson: jest.fn(),
  sleep: jest.fn(),
}));
jest.mock('./terminal', () => ({
  enterAltScreen: jest.fn(),
  exitAltScreen: jest.fn(),
}));
jest.mock('./run-format', () => ({
  formatInstanceLine: jest.fn((inst: { name: string }) => `  ${inst.name}`),
  printSummary: jest.fn(),
  categorizeInstances: jest.fn((instances: Array<{ status: string }>) => ({
    inProgress: instances.filter((i) => i.status === 'RUNNING'),
    done: instances.filter(
      (i) => i.status !== 'RUNNING' && i.status !== 'PENDING',
    ),
    pendingCount: instances.filter((i) => i.status === 'PENDING').length,
    passedCount: instances.filter(
      (i) => (i as any).testStatus === 'PASSED' || i.status === 'COMPLETED',
    ).length,
    failedCount: instances.filter(
      (i) => (i as any).testStatus === 'FAILED' || i.status === 'FAILED',
    ).length,
  })),
  SPINNER_FRAMES: ['|', '/', '-', '\\'],
  TERMINAL_INSTANCE_STATUSES: new Set([
    'PASSED',
    'FAILED',
    'COMPLETED',
    'SKIPPED',
  ]),
}));
jest.mock('./formatting', () => ({
  formatDuration: jest.fn((ms: number) => `${Math.round(ms / 1000)}s`),
}));

import { pollForCompletion } from './run-display';
import { fetchJson, sleep } from './cli-utils';
import { enterAltScreen, exitAltScreen } from './terminal';
import { formatInstanceLine, printSummary } from './run-format';

const mockFetchJson = fetchJson as jest.Mock;
const mockSleep = sleep as jest.Mock;
const _mockEnterAltScreen = enterAltScreen as jest.Mock;
const _mockExitAltScreen = exitAltScreen as jest.Mock;
const mockFormatInstanceLine = formatInstanceLine as jest.Mock;
const mockPrintSummary = printSummary as jest.Mock;

// Non-TTY to avoid alt screen complexity
Object.defineProperty(process.stdout, 'isTTY', {
  value: false,
  configurable: true,
});

// Suppress stdout.write
jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
jest.spyOn(console, 'log').mockImplementation();

beforeEach(() => {
  jest.clearAllMocks();
  mockSleep.mockResolvedValue(undefined);
});

describe('pollForCompletion', () => {
  it('returns passed=true when run status is COMPLETED', async () => {
    mockFetchJson.mockResolvedValue({
      runId: 'run-1',
      status: 'COMPLETED',
      instances: [
        {
          id: 'inst-1',
          name: 'test-a',
          status: 'COMPLETED',
          testStatus: 'PASSED',
        },
      ],
    });

    const result = await pollForCompletion('http://ct:19001', 'run-1');

    expect(result.passed).toBe(true);
    expect(result.runId).toBe('run-1');
    expect(result.instances).toHaveLength(1);
    expect(result.instances[0].name).toBe('test-a');
  });

  it('returns passed=false when run status is FAILED', async () => {
    mockFetchJson.mockResolvedValue({
      runId: 'run-1',
      status: 'FAILED',
      instances: [
        {
          id: 'inst-1',
          name: 'test-a',
          status: 'COMPLETED',
          testStatus: 'FAILED',
        },
      ],
    });

    const result = await pollForCompletion('http://ct:19001', 'run-1');

    expect(result.passed).toBe(false);
  });

  it('includes skipped instances in result', async () => {
    mockFetchJson.mockResolvedValue({
      runId: 'run-1',
      status: 'COMPLETED',
      instances: [
        {
          id: 'inst-1',
          name: 'test-a',
          status: 'COMPLETED',
          testStatus: 'PASSED',
        },
      ],
    });

    const skipped = [
      {
        id: 'skip-1',
        name: 'bad-def',
        status: 'SKIPPED',
        testStatus: 'SKIPPED',
        errorMessage: 'Invalid definition',
      },
    ];

    const result = await pollForCompletion(
      'http://ct:19001',
      'run-1',
      undefined,
      skipped,
    );

    expect(result.instances).toHaveLength(2);
    expect(result.instances.find((i) => i.name === 'bad-def')).toBeDefined();
  });

  it('handles abort signal - returns early with passed=false', async () => {
    const abort = new AbortController();

    // First poll returns RUNNING, then we abort
    let callCount = 0;
    mockFetchJson.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          runId: 'run-1',
          status: 'RUNNING',
          instances: [{ id: 'inst-1', name: 'test-a', status: 'RUNNING' }],
        };
      }
      return null;
    });

    mockSleep.mockImplementation(async () => {
      // Abort after the first render cycle
      abort.abort();
    });

    const result = await pollForCompletion('http://ct:19001', 'run-1', abort);

    expect(result.passed).toBe(false);
    expect(result.runId).toBe('run-1');
  });

  it('transitions from RUNNING to COMPLETED', async () => {
    let callCount = 0;
    mockFetchJson.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        return {
          runId: 'run-1',
          status: 'RUNNING',
          instances: [{ id: 'inst-1', name: 'test-a', status: 'RUNNING' }],
        };
      }
      return {
        runId: 'run-1',
        status: 'COMPLETED',
        instances: [
          {
            id: 'inst-1',
            name: 'test-a',
            status: 'COMPLETED',
            testStatus: 'PASSED',
          },
        ],
      };
    });

    // The poll timer fires every POLL_INTERVAL_MS (1000ms). The render loop
    // calls sleep(RENDER_INTERVAL_MS=100) each tick. We need enough ticks for
    // the poll timer to fire at least once after the initial poll.
    // Mock sleep to resolve immediately but allow poll timer to run.
    let _sleepCalls = 0;
    mockSleep.mockImplementation(async () => {
      _sleepCalls++;
      // After a few render ticks, trigger the interval callback by advancing
      // We rely on real setInterval — just need enough async ticks
      await new Promise((r) => setTimeout(r, 0));
    });

    const result = await pollForCompletion('http://ct:19001', 'run-1');

    expect(result.passed).toBe(true);
    expect(result.runId).toBe('run-1');
  });

  it('calls formatInstanceLine and printSummary on completion', async () => {
    mockFetchJson.mockResolvedValue({
      runId: 'run-1',
      status: 'COMPLETED',
      instances: [
        {
          id: 'inst-1',
          name: 'test-a',
          status: 'COMPLETED',
          testStatus: 'PASSED',
        },
        {
          id: 'inst-2',
          name: 'test-b',
          status: 'COMPLETED',
          testStatus: 'FAILED',
        },
      ],
    });

    await pollForCompletion('http://ct:19001', 'run-1');

    expect(mockFormatInstanceLine).toHaveBeenCalled();
    expect(mockPrintSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        status: 'COMPLETED',
      }),
      expect.any(Number),
      expect.any(Map),
      expect.any(Map),
    );
  });

  it('tracks instance start/completion times', async () => {
    // First poll: instance is RUNNING (starts tracking)
    // Second poll: instance is COMPLETED (marks completion)
    let callCount = 0;
    mockFetchJson.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        return {
          runId: 'run-1',
          status: 'RUNNING',
          instances: [{ id: 'inst-1', name: 'test-a', status: 'RUNNING' }],
        };
      }
      return {
        runId: 'run-1',
        status: 'COMPLETED',
        instances: [
          {
            id: 'inst-1',
            name: 'test-a',
            status: 'COMPLETED',
            testStatus: 'PASSED',
          },
        ],
      };
    });

    mockSleep.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    await pollForCompletion('http://ct:19001', 'run-1');

    // printSummary should have been called with Maps tracking start/completion times
    expect(mockPrintSummary).toHaveBeenCalled();
    const [, , startMap, completionMap] = mockPrintSummary.mock.calls[0];
    // The RUNNING instance should have a start time recorded
    expect(startMap.has('inst-1')).toBe(true);
    // The COMPLETED instance should have a completion time recorded
    expect(completionMap.has('inst-1')).toBe(true);
  });
});
