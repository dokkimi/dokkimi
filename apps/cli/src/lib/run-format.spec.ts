import type { RunStatusInstance, RunStatusResponse } from './run-display';
import {
  categorizeInstances,
  formatInstanceLine,
  formatOutcomeCounts,
  printSummary,
} from './run-format';

// The states Control Tower reports: the instance's status and test result
const passed = { status: 'STOPPED', testStatus: 'PASSED' };
const failed = { status: 'STOPPED', testStatus: 'FAILED' };
const stoppedNoResult = { status: 'STOPPED' };
const invalid = { status: 'INVALID', errorMessage: 'Invalid definition' };

function inst(
  id: string,
  state: Partial<RunStatusInstance>,
): RunStatusInstance {
  return { id, name: id, status: 'PENDING', ...state };
}

// ---------------------------------------------------------------------------
// categorizeInstances
// ---------------------------------------------------------------------------

describe('categorizeInstances', () => {
  it('counts pending, running and finished definitions', () => {
    const result = categorizeInstances('RUNNING', [
      inst('a', { status: 'PENDING' }),
      inst('b', { status: 'RUNNING' }),
      inst('c', passed),
      inst('d', failed),
    ]);
    expect(result.pendingCount).toBe(1);
    expect(result.inProgress.map((i) => i.id)).toEqual(['b']);
    expect(result.done.map((i) => i.id)).toEqual(['c', 'd']);
    expect(result.passedCount).toBe(1);
    expect(result.failedCount).toBe(1);
  });

  it('counts a test result before its teardown ends', () => {
    const result = categorizeInstances('RUNNING', [
      inst('a', { status: 'RUNNING', testStatus: 'PASSED' }),
    ]);
    expect(result.done).toHaveLength(1);
    expect(result.passedCount).toBe(1);
  });

  // Before, a stopped definition with no result was in neither count
  it('counts anything finished without passing as not passed', () => {
    const result = categorizeInstances('CANCELLED', [
      inst('a', stoppedNoResult),
      inst('b', { status: 'PENDING' }),
      inst('c', invalid),
    ]);
    expect(result.done).toHaveLength(3);
    expect(result.failedCount).toBe(3);
    expect(result.passedCount).toBe(0);
  });

  it('handles an empty list', () => {
    expect(categorizeInstances('RUNNING', [])).toEqual({
      inProgress: [],
      done: [],
      pendingCount: 0,
      passedCount: 0,
      failedCount: 0,
    });
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

  const line = (
    runStatus: string,
    state: Partial<RunStatusInstance>,
    start?: number,
    end?: number,
    spinner = '',
  ) =>
    formatInstanceLine(
      runStatus,
      inst('my-service', state),
      start,
      end,
      spinner,
    );

  it('shows a checkmark for a passed test', () => {
    expect(line('COMPLETED', passed, 0, 100)).toContain('\x1b[32m✔\x1b[0m');
    expect(line('COMPLETED', passed, 0, 100)).toContain('PASSED');
  });

  it('shows an X for a failed test', () => {
    expect(line('FAILED', failed, 0, 100)).toContain('\x1b[31m✘\x1b[0m');
  });

  it.each([
    ['CANCELLED', stoppedNoResult, 'CANCELLED'],
    ['FAILED', stoppedNoResult, 'NOT RUN'],
    ['RUNNING', invalid, 'INVALID'],
  ])(
    'shows an X and %s for a definition without a result',
    (run, state, label) => {
      const text = line(run, state as Partial<RunStatusInstance>, 0, 100);
      expect(text).toContain('\x1b[31m✘\x1b[0m');
      expect(text).toContain(label);
    },
  );

  it('shows the spinner and the phase while running', () => {
    const text = line('RUNNING', { status: 'STARTING' }, 0, undefined, '⏳');
    expect(text).toContain('⏳');
    expect(text).toContain('STARTING');
  });

  it('pads the name to 30 characters', () => {
    expect(
      formatInstanceLine('RUNNING', inst('svc', {}), undefined, undefined, ''),
    ).toContain('svc' + ' '.repeat(27));
  });

  it('shows the duration when started and completed', () => {
    expect(line('COMPLETED', passed, 1000, 3500)).toContain('2.5s');
  });

  it('shows no duration when not started', () => {
    const text = line('COMPLETED', passed, undefined, 100);
    expect(text).not.toMatch(/\d+(\.\d+)?s\)/);
    expect(text).not.toMatch(/\d+ms\)/);
  });

  it('truncates the error message to the available width', () => {
    const longError = 'A'.repeat(200);
    const text = line('FAILED', { ...failed, errorMessage: longError }, 0, 100);
    expect(text).toContain('…');
    expect(text).not.toContain(longError);
  });
});

// ---------------------------------------------------------------------------
// printSummary and formatOutcomeCounts
// ---------------------------------------------------------------------------

describe('printSummary', () => {
  let logSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  const output = () => logSpy.mock.calls.map((c) => c[0]).join('\n');
  const status = (
    runStatus: string,
    instances: RunStatusInstance[],
  ): RunStatusResponse => ({ runId: 'r1', status: runStatus, instances });

  it('says all passed, in green, only when every definition passed', () => {
    printSummary(
      status('COMPLETED', [inst('a', passed), inst('b', passed)]),
      5000,
      new Map(),
      new Map(),
    );
    expect(output()).toContain('\x1b[32m2 of 2 definitions passed.');
  });

  it('counts each kind of not passing, in red', () => {
    printSummary(
      status('FAILED', [inst('a', passed), inst('b', failed)]),
      3000,
      new Map(),
      new Map(),
    );
    expect(output()).toContain('\x1b[31m1 of 2 definitions passed: 1 failed.');
  });

  // Before, "2 of 2 passed" when one never ran
  it('does not call a run passed when a definition never ran', () => {
    printSummary(
      status('FAILED', [inst('a', passed), inst('b', stoppedNoResult)]),
      3000,
      new Map(),
      new Map(),
    );
    expect(output()).toContain('1 of 2 definitions passed: 1 not run.');
  });

  // Before, invalid definitions were left out of the count
  it('counts invalid definitions', () => {
    printSummary(
      status('COMPLETED', [inst('a', passed), inst('b', invalid)]),
      2000,
      new Map(),
      new Map(),
    );
    expect(output()).toContain('1 of 2 definitions passed: 1 invalid.');
  });

  it('says a cancelled run was cancelled', () => {
    printSummary(
      status('CANCELLED', [inst('a', passed), inst('b', stoppedNoResult)]),
      2000,
      new Map(),
      new Map(),
    );
    expect(output()).toContain(
      'Run cancelled. 1 of 2 definitions passed: 1 cancelled.',
    );
  });

  it('includes the total and average duration', () => {
    printSummary(
      status('COMPLETED', [inst('a', passed), inst('b', passed)]),
      5000,
      new Map([
        ['a', 0],
        ['b', 0],
      ]),
      new Map([
        ['a', 1000],
        ['b', 3000],
      ]),
    );
    expect(output()).toContain('total 5.0s');
    expect(output()).toContain('avg 2.0s');
  });
});

describe('formatOutcomeCounts', () => {
  it('uses the singular for one definition', () => {
    expect(formatOutcomeCounts('COMPLETED', [inst('a', passed)])).toContain(
      '1 of 1 definition passed.',
    );
  });
});
