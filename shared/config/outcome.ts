/** What became of one definition in a run */
export type Outcome = 'passed' | 'failed' | 'cancelled' | 'not-run' | 'running';

const ACTIVE_RUN_STATUSES = new Set(['PENDING', 'RUNNING']);

/**
 * A definition's outcome, from what Control Tower stores: the run's status,
 * and the instance's status and test result. Every tool uses this; before,
 * each combined them itself, and some counted cancelled, stopped or
 * unfinished definitions as passed.
 */
export function instanceOutcome(
  runStatus: string,
  inst: { status: string; testStatus?: string | null },
): Outcome {
  // A test's result is the definition's result, whatever happened after it
  if (inst.testStatus === 'PASSED') {
    return 'passed';
  }
  if (inst.testStatus === 'FAILED' || inst.status === 'FAILED') {
    return 'failed';
  }
  if (inst.testStatus === 'CANCELLED' || runStatus === 'CANCELLED') {
    return 'cancelled';
  }
  // Stopped with no result, or the run ended before it started
  if (inst.status === 'STOPPED' || !ACTIVE_RUN_STATUSES.has(runStatus)) {
    return 'not-run';
  }
  return 'running';
}

/** How many definitions had each outcome */
export function countOutcomes(
  runStatus: string,
  instances: { status: string; testStatus?: string | null }[],
): Record<Outcome, number> {
  const counts: Record<Outcome, number> = {
    passed: 0,
    failed: 0,
    cancelled: 0,
    'not-run': 0,
    running: 0,
  };
  for (const inst of instances) {
    counts[instanceOutcome(runStatus, inst)]++;
  }
  return counts;
}
