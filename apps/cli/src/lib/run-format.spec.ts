import type { RunStatusInstance, RunStatusResponse } from './run-display';
import {
  categorizeInstances,
  formatInstanceLine,
  printSummary,
} from './run-format';

// ---------------------------------------------------------------------------
// categorizeInstances
// ---------------------------------------------------------------------------

describe('categorizeInstances', () => {
  function inst(
    id: string,
    status: string,
    testStatus?: string,
  ): RunStatusInstance {
    return { id, name: id, status, testStatus };
  }

  it('buckets PENDING into pendingCount', () => {
    const result = categorizeInstances([inst('a', 'PENDING')]);
    expect(result.pendingCount).toBe(1);
    expect(result.inProgress).toHaveLength(0);
    expect(result.done).toHaveLength(0);
  });

  it('buckets PASSED into done + passedCount', () => {
    const result = categorizeInstances([inst('a', 'PASSED')]);
    expect(result.done).toHaveLength(1);
    expect(result.passedCount).toBe(1);
  });

  it('buckets COMPLETED into done + passedCount', () => {
    const result = categorizeInstances([inst('a', 'COMPLETED')]);
    expect(result.done).toHaveLength(1);
    expect(result.passedCount).toBe(1);
  });

  it('buckets FAILED into done + failedCount', () => {
    const result = categorizeInstances([inst('a', 'FAILED')]);
    expect(result.done).toHaveLength(1);
    expect(result.failedCount).toBe(1);
  });

  it('buckets STOPPED into done without incrementing pass/fail', () => {
    const result = categorizeInstances([inst('a', 'STOPPED')]);
    expect(result.done).toHaveLength(1);
    expect(result.passedCount).toBe(0);
    expect(result.failedCount).toBe(0);
  });

  it('buckets SKIPPED into done without incrementing pass/fail', () => {
    const result = categorizeInstances([inst('a', 'SKIPPED')]);
    expect(result.done).toHaveLength(1);
    expect(result.passedCount).toBe(0);
    expect(result.failedCount).toBe(0);
  });

  it('buckets RUNNING/BOOTING into inProgress', () => {
    const result = categorizeInstances([
      inst('a', 'RUNNING'),
      inst('b', 'BOOTING'),
    ]);
    expect(result.inProgress).toHaveLength(2);
    expect(result.done).toHaveLength(0);
  });

  it('uses testStatus when available', () => {
    const result = categorizeInstances([inst('a', 'RUNNING', 'PASSED')]);
    expect(result.done).toHaveLength(1);
    expect(result.passedCount).toBe(1);
    expect(result.inProgress).toHaveLength(0);
  });

  it('handles empty array', () => {
    const result = categorizeInstances([]);
    expect(result.inProgress).toHaveLength(0);
    expect(result.done).toHaveLength(0);
    expect(result.pendingCount).toBe(0);
    expect(result.passedCount).toBe(0);
    expect(result.failedCount).toBe(0);
  });

  it('handles all-same-status array', () => {
    const instances = Array.from({ length: 5 }, (_, i) =>
      inst(`i${i}`, 'FAILED'),
    );
    const result = categorizeInstances(instances);
    expect(result.failedCount).toBe(5);
    expect(result.done).toHaveLength(5);
    expect(result.passedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatInstanceLine
// ---------------------------------------------------------------------------

describe('formatInstanceLine', () => {
  const origColumns = process.stdout.columns;

  beforeEach(() => {
    Object.defineProperty(process.stdout, 'columns', {
      value: 120,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'columns', {
      value: origColumns,
      writable: true,
      configurable: true,
    });
  });

  function inst(overrides: Partial<RunStatusInstance> = {}): RunStatusInstance {
    return {
      id: 'i1',
      name: 'my-service',
      status: 'RUNNING',
      ...overrides,
    };
  }

  it('shows checkmark prefix for PASSED', () => {
    const line = formatInstanceLine(inst({ status: 'PASSED' }), 0, 100, '');
    expect(line).toContain('\x1b[32m✔\x1b[0m');
  });

  it('shows X prefix for FAILED', () => {
    const line = formatInstanceLine(inst({ status: 'FAILED' }), 0, 100, '');
    expect(line).toContain('\x1b[31m✘\x1b[0m');
  });

  it('shows dash for SKIPPED', () => {
    const line = formatInstanceLine(inst({ status: 'SKIPPED' }), 0, 100, '');
    expect(line).toContain('\x1b[90m–\x1b[0m');
  });

  it('shows spinner for in-progress status', () => {
    const line = formatInstanceLine(
      inst({ status: 'RUNNING' }),
      0,
      undefined,
      '⏳',
    );
    expect(line).toContain('⏳');
  });

  it('pads name to 30 chars', () => {
    const line = formatInstanceLine(
      inst({ name: 'svc' }),
      undefined,
      undefined,
      '',
    );
    // 'svc' padded to 30 chars
    expect(line).toContain('svc' + ' '.repeat(27));
  });

  it('shows duration when started and completed', () => {
    const line = formatInstanceLine(inst({ status: 'PASSED' }), 1000, 3500, '');
    expect(line).toContain('2.5s');
  });

  it('shows no duration when startedAt is undefined', () => {
    const line = formatInstanceLine(
      inst({ status: 'PASSED' }),
      undefined,
      100,
      '',
    );
    // No duration text should appear
    expect(line).not.toMatch(/\d+(\.\d+)?s\)/);
    expect(line).not.toMatch(/\d+ms\)/);
  });

  it('shows error message truncated to available width', () => {
    const longError = 'A'.repeat(200);
    const line = formatInstanceLine(
      inst({ status: 'FAILED', errorMessage: longError }),
      0,
      100,
      '',
    );
    // Should contain truncated error with ellipsis
    expect(line).toContain('…');
    // Should not contain full error
    expect(line).not.toContain(longError);
  });
});

// ---------------------------------------------------------------------------
// printSummary
// ---------------------------------------------------------------------------

describe('printSummary', () => {
  let logSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function makeStatus(instances: RunStatusInstance[]): RunStatusResponse {
    return { runId: 'r1', status: 'COMPLETED', instances };
  }

  function inst(
    id: string,
    status: string,
    testStatus?: string,
  ): RunStatusInstance {
    return { id, name: id, status, testStatus };
  }

  it('prints green "N of N passed" when all pass', () => {
    const status = makeStatus([inst('a', 'PASSED'), inst('b', 'PASSED')]);
    const started = new Map([
      ['a', 0],
      ['b', 0],
    ]);
    const completed = new Map([
      ['a', 1000],
      ['b', 2000],
    ]);

    printSummary(status, 5000, started, completed);

    const allOutput = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('\x1b[32m');
    expect(allOutput).toContain('2 of 2 definitions passed.');
  });

  it('prints red "N of N failed" when some fail', () => {
    const status = makeStatus([inst('a', 'PASSED'), inst('b', 'FAILED')]);

    printSummary(status, 3000, new Map(), new Map());

    const allOutput = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('\x1b[31m');
    expect(allOutput).toContain('1 of 2 definitions failed.');
  });

  it('includes total duration', () => {
    const status = makeStatus([inst('a', 'PASSED')]);

    printSummary(status, 1500, new Map(), new Map());

    const allOutput = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('total 1.5s');
  });

  it('includes avg duration when >1 instance', () => {
    const status = makeStatus([inst('a', 'PASSED'), inst('b', 'PASSED')]);
    const started = new Map([
      ['a', 0],
      ['b', 0],
    ]);
    const completed = new Map([
      ['a', 1000],
      ['b', 3000],
    ]);

    printSummary(status, 5000, started, completed);

    const allOutput = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('avg 2.0s');
  });

  it('includes skipped count', () => {
    const status = makeStatus([
      inst('a', 'PASSED'),
      inst('b', 'SKIPPED'),
      inst('c', 'SKIPPED'),
    ]);

    printSummary(status, 2000, new Map(), new Map());

    const allOutput = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('2 skipped');
    // Only 1 ran (3 total - 2 skipped)
    expect(allOutput).toContain('1 of 1 definition passed.');
  });
});
