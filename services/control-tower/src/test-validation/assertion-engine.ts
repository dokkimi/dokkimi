import {
  Assertion,
  AssertionOperator,
  CountAssertion,
  ExtractRule,
} from '@dokkimi/config';

export interface AssertionResult {
  passed: boolean;
  error?: string;
  expected?: any;
  actual?: any;
  path?: string;
  operator?: string;
  blockIndex?: number;
  resultKind?: 'field' | 'count' | 'extract';
}

/**
 * Evaluates a dotted path against an assembled document.
 *
 * Supports:
 * - "response.body.user.name"
 * - "data[0].email"
 * - "responseTime"
 * - "success"
 */
export function evaluateDocPath(doc: any, path: string): any {
  if (!path) {
    return undefined;
  }
  if (doc === null || doc === undefined) {
    return undefined;
  }

  // Strip JSONPath root prefix if present
  if (path.startsWith('$.')) {
    path = path.slice(2);
  }

  // Split path into segments, handling array indices
  const segments: string[] = [];
  let current = '';
  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    if (ch === '.') {
      if (current) {
        segments.push(current);
      }
      current = '';
    } else if (ch === '[') {
      if (current) {
        segments.push(current);
      }
      const closeIdx = path.indexOf(']', i);
      if (closeIdx === -1) {
        return undefined;
      }
      segments.push(path.slice(i, closeIdx + 1));
      i = closeIdx;
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) {
    segments.push(current);
  }

  let value = doc;
  for (const seg of segments) {
    if (value === null || value === undefined) {
      return undefined;
    }

    const arrayMatch = seg.match(/^\[(\d+)\]$/);
    if (arrayMatch) {
      if (!Array.isArray(value)) {
        return undefined;
      }
      const index = parseInt(arrayMatch[1], 10);
      if (index < 0 || index >= value.length) {
        return undefined;
      }
      value = value[index];
    } else {
      if (value[seg] !== undefined) {
        value = value[seg];
      } else if (typeof value === 'object') {
        // Case-insensitive fallback for header keys
        const lowerSeg = seg.toLowerCase();
        const match = Object.keys(value).find(
          (k) => k.toLowerCase() === lowerSeg,
        );
        value = match !== undefined ? value[match] : undefined;
      } else {
        value = undefined;
      }
    }
  }

  return value;
}

function ciEquals(a: any, b: any): boolean {
  if (typeof a === 'string' && typeof b === 'string') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

export function compareValues(
  operator: AssertionOperator,
  actual: any,
  expected: any,
): AssertionResult {
  switch (operator) {
    case 'eq':
      return {
        passed: ciEquals(actual, expected),
        expected,
        actual,
      };
    case 'ne':
      return {
        passed: !ciEquals(actual, expected),
        expected,
        actual,
      };
    case 'gt':
      return {
        passed: actual > expected,
        expected,
        actual,
      };
    case 'gte':
      return {
        passed: actual >= expected,
        expected,
        actual,
      };
    case 'lt':
      return {
        passed: actual < expected,
        expected,
        actual,
      };
    case 'lte':
      return {
        passed: actual <= expected,
        expected,
        actual,
      };
    case 'contains':
      return {
        passed: String(actual)
          .toLowerCase()
          .includes(String(expected).toLowerCase()),
        expected,
        actual,
      };
    case 'notContains':
      return {
        passed: !String(actual)
          .toLowerCase()
          .includes(String(expected).toLowerCase()),
        expected,
        actual,
      };
    case 'matches':
      try {
        const regex = new RegExp(String(expected));
        return {
          passed: regex.test(String(actual)),
          expected,
          actual,
        };
      } catch {
        return {
          passed: false,
          error: `Invalid regex pattern: ${expected}`,
        };
      }
    case 'in':
      return {
        passed: Array.isArray(expected) && expected.includes(actual),
        expected,
        actual,
      };
    case 'notIn':
      return {
        passed: Array.isArray(expected) && !expected.includes(actual),
        expected,
        actual,
      };
    case 'type': {
      const actualType = Array.isArray(actual) ? 'array' : typeof actual;
      return {
        passed: actualType === expected,
        expected,
        actual: actualType,
      };
    }
    case 'length': {
      const length =
        Array.isArray(actual) || typeof actual === 'string'
          ? actual.length
          : undefined;
      return {
        passed: length !== undefined && length === expected,
        expected,
        actual: length,
      };
    }
    case 'arrayContains':
      if (!Array.isArray(actual)) {
        return {
          passed: false,
          error: 'Value is not an array',
          expected,
          actual,
        };
      }
      return {
        passed: actual.includes(expected),
        expected,
        actual,
      };
    case 'arrayNotContains':
      if (!Array.isArray(actual)) {
        return {
          passed: false,
          error: 'Value is not an array',
          expected,
          actual,
        };
      }
      return {
        passed: !actual.includes(expected),
        expected,
        actual,
      };
    case 'isEmpty': {
      const isEmptyValue =
        actual === null ||
        actual === undefined ||
        (Array.isArray(actual) && actual.length === 0) ||
        (typeof actual === 'object' && Object.keys(actual).length === 0);
      return {
        passed: isEmptyValue,
        expected: 'empty',
        actual: isEmptyValue ? 'empty' : 'not empty',
      };
    }
    case 'notEmpty': {
      const isNotEmpty =
        actual !== null &&
        actual !== undefined &&
        !(Array.isArray(actual) && actual.length === 0) &&
        !(typeof actual === 'object' && Object.keys(actual).length === 0);
      return {
        passed: isNotEmpty,
        expected: 'not empty',
        actual: isNotEmpty ? 'not empty' : 'empty',
      };
    }
    default:
      return { passed: false, error: `Unknown operator: ${operator}` };
  }
}

export function validateAssertion(
  assertion: Assertion,
  doc: Record<string, any>,
): AssertionResult {
  const { path, operator, value: expected } = assertion;
  const actual = evaluateDocPath(doc, path);

  if (operator === 'exists') {
    return {
      passed: actual !== undefined && actual !== null,
      expected: 'exists',
      actual:
        actual === undefined
          ? 'not found'
          : actual === null
            ? 'null'
            : 'exists',
    };
  }

  if (operator === 'notExists') {
    return {
      passed: actual === undefined || actual === null,
      expected: 'not exists',
      actual:
        actual === undefined
          ? 'not found'
          : actual === null
            ? 'null'
            : 'exists',
    };
  }

  if (actual === undefined) {
    return {
      passed: false,
      error: `Path '${path}' not found in document`,
      expected,
      actual: undefined,
    };
  }

  return compareValues(operator, actual, expected);
}

export function validateCount(
  actual: number,
  count: CountAssertion,
): AssertionResult {
  const expected = count.value;
  switch (count.operator) {
    case 'eq':
      return { passed: actual === expected, expected, actual };
    case 'gte':
      return { passed: actual >= expected, expected, actual };
    case 'lte':
      return { passed: actual <= expected, expected, actual };
    case 'gt':
      return { passed: actual > expected, expected, actual };
    case 'lt':
      return { passed: actual < expected, expected, actual };
    default:
      return { passed: false, error: `Unknown operator: ${count.operator}` };
  }
}

export function resolveExtractRule(
  doc: Record<string, any>,
  variable: string,
  rule: ExtractRule,
): string {
  const path = typeof rule === 'string' ? rule : rule.path;
  const rawValue = evaluateDocPath(doc, path);

  if (rawValue === undefined) {
    throw new Error(
      `Failed to extract variable '${variable}': path '${path}' not found`,
    );
  }

  const strValue =
    typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue);

  if (typeof rule === 'string') {
    return strValue;
  }

  // Regex extraction
  const re = new RegExp(rule.pattern);
  const group = rule.group ?? 1;
  const matches = re.exec(strValue);

  if (!matches) {
    throw new Error(
      `Failed to extract variable '${variable}': pattern '${rule.pattern}' did not match value '${strValue}'`,
    );
  }
  if (group < 0 || group >= matches.length) {
    throw new Error(
      `Failed to extract variable '${variable}': capture group ${group} out of range (pattern has ${matches.length - 1} groups)`,
    );
  }

  return matches[group];
}
