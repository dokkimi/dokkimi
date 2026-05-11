import { Assertion, AssertionBlock } from '@dokkimi/config';
import { AssertionResult, validateAssertion } from '../assertion-engine';

export function validateSelfBlock(
  block: AssertionBlock,
  stepDoc: Record<string, any>,
): AssertionResult[] {
  if (Object.keys(stepDoc).length === 0) {
    return block.assertions.map((assertion: Assertion) => ({
      passed: false,
      error: 'Step log not found',
      path: assertion.path,
      operator: assertion.operator,
      resultKind: 'field' as const,
    }));
  }

  return block.assertions
    .filter((assertion: Assertion) => !assertion.disabled)
    .map((assertion: Assertion) => ({
      ...validateAssertion(assertion, stepDoc),
      path: assertion.path,
      operator: assertion.operator,
      resultKind: 'field' as const,
    }));
}
