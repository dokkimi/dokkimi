import { countOutcomes, instanceOutcome } from './outcome';

describe('instanceOutcome', () => {
  it.each([
    // run, instance status, test status, outcome
    ['COMPLETED', 'STOPPED', 'PASSED', 'passed'],
    // A teardown that failed after the test doesn't change its result
    ['FAILED', 'FAILED', 'PASSED', 'passed'],
    ['FAILED', 'STOPPED', 'FAILED', 'failed'],
    // A deploy or a crash failed it before any result
    ['FAILED', 'FAILED', null, 'failed'],
    ['RUNNING', 'FAILED', null, 'failed'],
    // Before, these counted as passed in some tools
    ['CANCELLED', 'STOPPED', null, 'cancelled'],
    ['CANCELLED', 'PENDING', null, 'cancelled'],
    ['CANCELLED', 'RUNNING', null, 'cancelled'],
    ['FAILED', 'STOPPED', null, 'not-run'],
    ['RUNNING', 'STOPPED', null, 'not-run'],
    ['FAILED', 'PENDING', null, 'not-run'],
    ['COMPLETED', 'PENDING', null, 'not-run'],
    ['RUNNING', 'PENDING', null, 'running'],
    ['RUNNING', 'RUNNING', null, 'running'],
    ['PENDING', 'STARTING', null, 'running'],
  ])('run %s, instance %s, test %s: %s', (run, status, testStatus, outcome) => {
    expect(instanceOutcome(run, { status, testStatus })).toBe(outcome);
  });

  it('counts each outcome', () => {
    expect(
      countOutcomes('FAILED', [
        { status: 'STOPPED', testStatus: 'PASSED' },
        { status: 'STOPPED', testStatus: 'FAILED' },
        { status: 'PENDING' },
      ]),
    ).toEqual({ passed: 1, failed: 1, cancelled: 0, 'not-run': 1, running: 0 });
  });
});
