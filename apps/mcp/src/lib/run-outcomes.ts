import { countOutcomes, instanceOutcome } from '@dokkimi/config';
import type { InstanceSummary, LatestRunResponse } from './ct-types';

/**
 * Each definition's outcome, and how many had each. Before, each tool
 * combined testStatus and status itself, so a cancelled, stopped or
 * unfinished definition was in no count.
 */
export function summarizeRun(run: LatestRunResponse) {
  const counts = countOutcomes(run.status, run.instances);
  return {
    summary: {
      total: run.instances.length,
      passed: counts.passed,
      failed: counts.failed,
      cancelled: counts.cancelled,
      notRun: counts['not-run'],
      running: counts.running,
    },
    instances: run.instances.map((inst) => ({
      id: inst.id,
      name: inst.name,
      outcome: instanceOutcome(run.status, inst),
      ...(inst.errorMessage ? { errorMessage: inst.errorMessage } : {}),
    })),
  };
}

/**
 * The definitions that ended without passing, or, when there are none, what
 * to say instead. Before, "All tests passed" was said of a run still going,
 * or one that was cancelled or stopped.
 */
export function endedWithoutPassing(
  run: LatestRunResponse,
): { instances: InstanceSummary[] } | { message: string } {
  const instances = run.instances.filter((i) => {
    const outcome = instanceOutcome(run.status, i);
    return outcome !== 'passed' && outcome !== 'running';
  });
  if (instances.length > 0) {
    return { instances };
  }
  const { passed, running } = countOutcomes(run.status, run.instances);
  if (running > 0) {
    return {
      message: `The run is still going: ${passed} of ${run.instances.length} passed so far, none failed yet.`,
    };
  }
  return { message: 'No failures found. All tests passed.' };
}
