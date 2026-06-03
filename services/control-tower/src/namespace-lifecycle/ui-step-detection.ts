import { DeployableDefinition } from './deployment-context.types';

/**
 * Returns true iff the resolved definition contains at least one step whose
 * action is a UI action (`action.type === "ui"`). Control Tower uses this
 * signal to deploy a standalone chromium pod with dnsmasq — API/DB-only
 * runs skip the browser pod entirely.
 *
 * Typed loosely against `action.type` because UiAction is not yet part of
 * the shared `StepAction` union; definitions are validated upstream in
 * @dokkimi/definition-validator before reaching the deployer.
 */
export function hasUiSteps(definition: DeployableDefinition): boolean {
  const tests = definition.tests;
  if (!tests || tests.length === 0) {
    return false;
  }
  for (const test of tests) {
    const steps = test.steps ?? [];
    for (const step of steps) {
      const action = (step as { action?: { type?: string } } | null | undefined)
        ?.action;
      if (action?.type === 'ui') {
        return true;
      }
    }
  }
  return false;
}
