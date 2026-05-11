import type { AssertionResult } from './assertion-engine';

export function formatAssertionMessage(result: AssertionResult): string {
  const status = result.passed ? 'PASSED' : 'FAILED';
  const errorSuffix = result.error ? ` - ${result.error}` : '';

  if (result.resultKind === 'extract') {
    return `Extract ${result.path || 'variable'}: ${status}${errorSuffix}`;
  }
  if (result.resultKind === 'count') {
    const label = result.path || 'Call count';
    return `${label} check: ${status} (expected: ${JSON.stringify(result.expected)}, actual: ${result.actual})${errorSuffix}`;
  }
  // field
  const expectedStr =
    result.expected !== undefined ? ` ${JSON.stringify(result.expected)}` : '';
  return `${result.path || 'unknown'} ${result.operator || '?'}${expectedStr}: ${status}${errorSuffix}`;
}
