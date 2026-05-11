import { formatAssertionMessage } from './assertion-result-formatter';
import type { AssertionResult } from './assertion-engine';

describe('formatAssertionMessage', () => {
  describe('extract results', () => {
    it('formats passed extract with path', () => {
      const result: AssertionResult = {
        passed: true,
        resultKind: 'extract',
        path: 'userId',
      };
      expect(formatAssertionMessage(result)).toBe('Extract userId: PASSED');
    });

    it('formats failed extract with error', () => {
      const result: AssertionResult = {
        passed: false,
        resultKind: 'extract',
        path: 'token',
        error: 'path not found',
      };
      expect(formatAssertionMessage(result)).toBe(
        'Extract token: FAILED - path not found',
      );
    });

    it('uses "variable" when path is missing', () => {
      const result: AssertionResult = {
        passed: true,
        resultKind: 'extract',
      };
      expect(formatAssertionMessage(result)).toBe('Extract variable: PASSED');
    });
  });

  describe('count results', () => {
    it('formats count check with expected and actual', () => {
      const result: AssertionResult = {
        passed: true,
        resultKind: 'count',
        path: 'console(ERROR)',
        expected: { operator: 'eq', value: 0 },
        actual: 0,
      };
      expect(formatAssertionMessage(result)).toBe(
        'console(ERROR) check: PASSED (expected: {"operator":"eq","value":0}, actual: 0)',
      );
    });

    it('uses "Call count" when path is missing', () => {
      const result: AssertionResult = {
        passed: false,
        resultKind: 'count',
        expected: 2,
        actual: 1,
      };
      expect(formatAssertionMessage(result)).toBe(
        'Call count check: FAILED (expected: 2, actual: 1)',
      );
    });

    it('includes error suffix', () => {
      const result: AssertionResult = {
        passed: false,
        resultKind: 'count',
        path: 'requests',
        expected: 3,
        actual: 0,
        error: 'no logs found',
      };
      expect(formatAssertionMessage(result)).toBe(
        'requests check: FAILED (expected: 3, actual: 0) - no logs found',
      );
    });
  });

  describe('field results', () => {
    it('formats field with path, operator, and expected', () => {
      const result: AssertionResult = {
        passed: true,
        resultKind: 'field',
        path: 'response.statusCode',
        operator: 'eq',
        expected: 200,
      };
      expect(formatAssertionMessage(result)).toBe(
        'response.statusCode eq 200: PASSED',
      );
    });

    it('formats failed field with error', () => {
      const result: AssertionResult = {
        passed: false,
        resultKind: 'field',
        path: 'response.body.id',
        operator: 'eq',
        expected: 'abc',
        error: 'type mismatch',
      };
      expect(formatAssertionMessage(result)).toBe(
        'response.body.id eq "abc": FAILED - type mismatch',
      );
    });

    it('uses "unknown" for missing path', () => {
      const result: AssertionResult = {
        passed: false,
        resultKind: 'field',
        operator: 'eq',
        expected: true,
      };
      expect(formatAssertionMessage(result)).toBe('unknown eq true: FAILED');
    });

    it('uses "?" for missing operator', () => {
      const result: AssertionResult = {
        passed: true,
        resultKind: 'field',
        path: 'response.body',
      };
      expect(formatAssertionMessage(result)).toBe('response.body ?: PASSED');
    });

    it('omits expected value when undefined', () => {
      const result: AssertionResult = {
        passed: true,
        resultKind: 'field',
        path: 'response.body',
        operator: 'exists',
      };
      expect(formatAssertionMessage(result)).toBe(
        'response.body exists: PASSED',
      );
    });

    it('handles undefined resultKind (defaults to field)', () => {
      const result: AssertionResult = {
        passed: true,
        path: 'response.statusCode',
        operator: 'eq',
        expected: 200,
      };
      expect(formatAssertionMessage(result)).toBe(
        'response.statusCode eq 200: PASSED',
      );
    });
  });
});
