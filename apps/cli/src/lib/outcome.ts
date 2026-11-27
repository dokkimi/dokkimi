import { instanceOutcome, type Outcome } from '@dokkimi/config';

/**
 * The status of the CLI's entry for a definition that failed validation: it
 * is listed with the run's definitions, but never reaches Control Tower.
 */
export const INVALID_STATUS = 'INVALID';

export type RunOutcome = Outcome | 'invalid';

interface InstanceState {
  status: string;
  testStatus?: string | null;
}

export function outcomeOf(runStatus: string, inst: InstanceState): RunOutcome {
  return inst.status === INVALID_STATUS
    ? 'invalid'
    : instanceOutcome(runStatus, inst);
}

const LABELS: Record<Exclude<RunOutcome, 'running'>, string> = {
  passed: 'PASSED',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
  'not-run': 'NOT RUN',
  invalid: 'INVALID',
};

/** What to show for a definition: its outcome, or while running its phase */
export function outcomeLabel(runStatus: string, inst: InstanceState): string {
  const outcome = outcomeOf(runStatus, inst);
  return outcome === 'running' ? inst.status : LABELS[outcome];
}

/** A run passed only when something ran and every definition passed */
export function runPassed(
  runStatus: string,
  instances: InstanceState[],
): boolean {
  return (
    instances.length > 0 &&
    instances.every((i) => outcomeOf(runStatus, i) === 'passed')
  );
}
