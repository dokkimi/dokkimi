import {
  evaluateDocPath,
  compareValues,
  validateAssertion,
  validateCount,
  resolveExtractRule,
} from './assertion-engine';

describe('evaluateDocPath', () => {
  const doc = {
    response: {
      status: 200,
      header: { 'content-type': 'application/json', 'X-Request-Id': 'abc' },
      body: {
        users: [
          { name: 'Alice', email: 'alice@test.com' },
          { name: 'Bob', email: 'bob@test.com' },
        ],
        count: 2,
        nested: { deep: { value: 42 } },
      },
    },
    request: { method: 'GET', url: '/users' },
    responseTime: 150,
  };

  it('resolves a top-level key', () => {
    expect(evaluateDocPath(doc, 'responseTime')).toBe(150);
  });

  it('resolves a nested dotted path', () => {
    expect(evaluateDocPath(doc, 'response.status')).toBe(200);
  });

  it('resolves deeply nested path', () => {
    expect(evaluateDocPath(doc, 'response.body.nested.deep.value')).toBe(42);
  });

  it('resolves array index', () => {
    expect(evaluateDocPath(doc, 'response.body.users[0].name')).toBe('Alice');
    expect(evaluateDocPath(doc, 'response.body.users[1].email')).toBe(
      'bob@test.com',
    );
  });

  it('returns undefined for out-of-bounds array index', () => {
    expect(evaluateDocPath(doc, 'response.body.users[5].name')).toBeUndefined();
  });

  it('returns undefined for array index on non-array', () => {
    expect(evaluateDocPath(doc, 'response.status[0]')).toBeUndefined();
  });

  it('returns undefined for missing path', () => {
    expect(evaluateDocPath(doc, 'response.missing.field')).toBeUndefined();
  });

  it('returns undefined for empty path', () => {
    expect(evaluateDocPath(doc, '')).toBeUndefined();
  });

  it('returns undefined for null doc', () => {
    expect(evaluateDocPath(null, 'foo')).toBeUndefined();
  });

  it('returns undefined for undefined doc', () => {
    expect(evaluateDocPath(undefined, 'foo')).toBeUndefined();
  });

  it('strips JSONPath root prefix $. ', () => {
    expect(evaluateDocPath(doc, '$.responseTime')).toBe(150);
    expect(evaluateDocPath(doc, '$.response.body.count')).toBe(2);
  });

  it('handles case-insensitive key fallback', () => {
    expect(evaluateDocPath(doc, 'response.header.x-request-id')).toBe('abc');
    expect(evaluateDocPath(doc, 'response.header.Content-Type')).toBe(
      'application/json',
    );
  });

  it('returns undefined for unclosed bracket', () => {
    expect(evaluateDocPath(doc, 'response.body.users[0')).toBeUndefined();
  });

  it('resolves path through null intermediate', () => {
    expect(evaluateDocPath({ a: { b: null } }, 'a.b.c')).toBeUndefined();
  });

  it('handles non-object intermediate (primitive)', () => {
    expect(evaluateDocPath({ a: 'hello' }, 'a.b')).toBeUndefined();
  });
});

describe('compareValues', () => {
  describe('eq', () => {
    it('passes for equal numbers', () => {
      expect(compareValues('eq', 200, 200).passed).toBe(true);
    });

    it('fails for unequal numbers', () => {
      expect(compareValues('eq', 200, 404).passed).toBe(false);
    });

    it('is case-insensitive for strings', () => {
      expect(compareValues('eq', 'Hello', 'hello').passed).toBe(true);
    });

    it('non-string types use strict equality', () => {
      expect(compareValues('eq', 1, '1' as any).passed).toBe(false);
    });
  });

  describe('ne', () => {
    it('passes for unequal values', () => {
      expect(compareValues('ne', 200, 404).passed).toBe(true);
    });

    it('fails for equal values', () => {
      expect(compareValues('ne', 200, 200).passed).toBe(false);
    });

    it('is case-insensitive for strings', () => {
      expect(compareValues('ne', 'Hello', 'hello').passed).toBe(false);
    });
  });

  describe('gt / gte / lt / lte', () => {
    it('gt passes when actual > expected', () => {
      expect(compareValues('gt', 10, 5).passed).toBe(true);
    });

    it('gt fails when actual === expected', () => {
      expect(compareValues('gt', 5, 5).passed).toBe(false);
    });

    it('gte passes when actual === expected', () => {
      expect(compareValues('gte', 5, 5).passed).toBe(true);
    });

    it('lt passes when actual < expected', () => {
      expect(compareValues('lt', 3, 5).passed).toBe(true);
    });

    it('lte passes when actual === expected', () => {
      expect(compareValues('lte', 5, 5).passed).toBe(true);
    });

    it('lte fails when actual > expected', () => {
      expect(compareValues('lte', 6, 5).passed).toBe(false);
    });
  });

  describe('contains / notContains', () => {
    it('contains passes for substring match (case-insensitive)', () => {
      expect(compareValues('contains', 'Hello World', 'hello').passed).toBe(
        true,
      );
    });

    it('contains fails when substring not present', () => {
      expect(compareValues('contains', 'Hello', 'xyz').passed).toBe(false);
    });

    it('notContains passes when substring not present', () => {
      expect(compareValues('notContains', 'Hello', 'xyz').passed).toBe(true);
    });

    it('notContains fails for substring match', () => {
      expect(compareValues('notContains', 'Hello World', 'world').passed).toBe(
        false,
      );
    });
  });

  describe('matches', () => {
    it('passes for matching regex', () => {
      expect(compareValues('matches', 'abc123', '\\d+').passed).toBe(true);
    });

    it('fails for non-matching regex', () => {
      expect(compareValues('matches', 'abcdef', '^\\d+$').passed).toBe(false);
    });

    it('returns error for invalid regex', () => {
      const result = compareValues('matches', 'test', '[invalid');
      expect(result.passed).toBe(false);
      expect(result.error).toContain('Invalid regex pattern');
    });
  });

  describe('in / notIn', () => {
    it('in passes when value is in array', () => {
      expect(compareValues('in', 'a', ['a', 'b', 'c']).passed).toBe(true);
    });

    it('in fails when value is not in array', () => {
      expect(compareValues('in', 'z', ['a', 'b', 'c']).passed).toBe(false);
    });

    it('in fails when expected is not an array', () => {
      expect(compareValues('in', 'a', 'a' as any).passed).toBe(false);
    });

    it('notIn passes when value is not in array', () => {
      expect(compareValues('notIn', 'z', ['a', 'b']).passed).toBe(true);
    });

    it('notIn fails when value is in array', () => {
      expect(compareValues('notIn', 'a', ['a', 'b']).passed).toBe(false);
    });
  });

  describe('type', () => {
    it('detects string type', () => {
      expect(compareValues('type', 'hello', 'string').passed).toBe(true);
    });

    it('detects number type', () => {
      expect(compareValues('type', 42, 'number').passed).toBe(true);
    });

    it('detects array type', () => {
      expect(compareValues('type', [1, 2], 'array').passed).toBe(true);
    });

    it('detects object type (not array)', () => {
      expect(compareValues('type', { a: 1 }, 'object').passed).toBe(true);
    });

    it('fails for mismatched type', () => {
      expect(compareValues('type', 'hello', 'number').passed).toBe(false);
    });
  });

  describe('length', () => {
    it('passes for correct array length', () => {
      expect(compareValues('length', [1, 2, 3], 3).passed).toBe(true);
    });

    it('passes for correct string length', () => {
      expect(compareValues('length', 'hello', 5).passed).toBe(true);
    });

    it('fails for wrong length', () => {
      expect(compareValues('length', [1, 2], 5).passed).toBe(false);
    });

    it('fails for non-array/non-string', () => {
      expect(compareValues('length', 42, 2).passed).toBe(false);
    });
  });

  describe('arrayContains / arrayNotContains', () => {
    it('arrayContains passes when item present', () => {
      expect(compareValues('arrayContains', [1, 2, 3], 2).passed).toBe(true);
    });

    it('arrayContains fails when item missing', () => {
      expect(compareValues('arrayContains', [1, 2, 3], 5).passed).toBe(false);
    });

    it('arrayContains fails for non-array', () => {
      const result = compareValues('arrayContains', 'not-array', 'a');
      expect(result.passed).toBe(false);
      expect(result.error).toBe('Value is not an array');
    });

    it('arrayNotContains passes when item missing', () => {
      expect(compareValues('arrayNotContains', [1, 2], 5).passed).toBe(true);
    });

    it('arrayNotContains fails when item present', () => {
      expect(compareValues('arrayNotContains', [1, 2], 2).passed).toBe(false);
    });

    it('arrayNotContains fails for non-array', () => {
      const result = compareValues('arrayNotContains', 'not-array', 'a');
      expect(result.passed).toBe(false);
      expect(result.error).toBe('Value is not an array');
    });
  });

  describe('isEmpty / notEmpty', () => {
    it('isEmpty passes for null', () => {
      expect(compareValues('isEmpty', null, undefined).passed).toBe(true);
    });

    it('isEmpty passes for undefined', () => {
      expect(compareValues('isEmpty', undefined, undefined).passed).toBe(true);
    });

    it('isEmpty passes for empty array', () => {
      expect(compareValues('isEmpty', [], undefined).passed).toBe(true);
    });

    it('isEmpty passes for empty object', () => {
      expect(compareValues('isEmpty', {}, undefined).passed).toBe(true);
    });

    it('isEmpty fails for non-empty string', () => {
      expect(compareValues('isEmpty', 'hello', undefined).passed).toBe(false);
    });

    it('isEmpty fails for non-empty array', () => {
      expect(compareValues('isEmpty', [1], undefined).passed).toBe(false);
    });

    it('notEmpty passes for non-empty array', () => {
      expect(compareValues('notEmpty', [1, 2], undefined).passed).toBe(true);
    });

    it('notEmpty fails for null', () => {
      expect(compareValues('notEmpty', null, undefined).passed).toBe(false);
    });

    it('notEmpty fails for empty object', () => {
      expect(compareValues('notEmpty', {}, undefined).passed).toBe(false);
    });
  });

  it('returns error for unknown operator', () => {
    const result = compareValues('unknownOp' as any, 1, 1);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('Unknown operator');
  });
});

describe('validateAssertion', () => {
  const doc = {
    response: { status: 200, body: { name: 'Alice' } },
  };

  it('validates exists for present value', () => {
    const result = validateAssertion(
      { path: 'response.status', operator: 'exists', value: undefined },
      doc,
    );
    expect(result.passed).toBe(true);
    expect(result.actual).toBe('exists');
  });

  it('validates exists for null value', () => {
    const result = validateAssertion(
      { path: 'response.status', operator: 'exists', value: undefined },
      { response: { status: null } },
    );
    expect(result.passed).toBe(false);
    expect(result.actual).toBe('null');
  });

  it('validates exists for missing value', () => {
    const result = validateAssertion(
      { path: 'response.missing', operator: 'exists', value: undefined },
      doc,
    );
    expect(result.passed).toBe(false);
    expect(result.actual).toBe('not found');
  });

  it('validates notExists for missing value', () => {
    const result = validateAssertion(
      { path: 'response.missing', operator: 'notExists', value: undefined },
      doc,
    );
    expect(result.passed).toBe(true);
  });

  it('validates notExists for null value', () => {
    const result = validateAssertion(
      { path: 'response.status', operator: 'notExists', value: undefined },
      { response: { status: null } },
    );
    expect(result.passed).toBe(true);
    expect(result.actual).toBe('null');
  });

  it('validates notExists fails for present value', () => {
    const result = validateAssertion(
      { path: 'response.status', operator: 'notExists', value: undefined },
      doc,
    );
    expect(result.passed).toBe(false);
    expect(result.actual).toBe('exists');
  });

  it('returns error when path not found and operator is not exists/notExists', () => {
    const result = validateAssertion(
      { path: 'response.missing', operator: 'eq', value: 200 },
      doc,
    );
    expect(result.passed).toBe(false);
    expect(result.error).toContain("Path 'response.missing' not found");
  });

  it('delegates to compareValues for standard operators', () => {
    const result = validateAssertion(
      { path: 'response.status', operator: 'eq', value: 200 },
      doc,
    );
    expect(result.passed).toBe(true);
  });
});

describe('validateCount', () => {
  it('eq passes for matching count', () => {
    expect(validateCount(3, { operator: 'eq', value: 3 }).passed).toBe(true);
  });

  it('eq fails for non-matching count', () => {
    expect(validateCount(2, { operator: 'eq', value: 3 }).passed).toBe(false);
  });

  it('gte passes at boundary', () => {
    expect(validateCount(3, { operator: 'gte', value: 3 }).passed).toBe(true);
  });

  it('gte passes above boundary', () => {
    expect(validateCount(5, { operator: 'gte', value: 3 }).passed).toBe(true);
  });

  it('gte fails below boundary', () => {
    expect(validateCount(2, { operator: 'gte', value: 3 }).passed).toBe(false);
  });

  it('lte passes at boundary', () => {
    expect(validateCount(3, { operator: 'lte', value: 3 }).passed).toBe(true);
  });

  it('gt passes above boundary', () => {
    expect(validateCount(4, { operator: 'gt', value: 3 }).passed).toBe(true);
  });

  it('gt fails at boundary', () => {
    expect(validateCount(3, { operator: 'gt', value: 3 }).passed).toBe(false);
  });

  it('lt passes below boundary', () => {
    expect(validateCount(2, { operator: 'lt', value: 3 }).passed).toBe(true);
  });

  it('lt fails at boundary', () => {
    expect(validateCount(3, { operator: 'lt', value: 3 }).passed).toBe(false);
  });

  it('returns error for unknown operator', () => {
    const result = validateCount(1, { operator: 'xxx' as any, value: 1 });
    expect(result.passed).toBe(false);
    expect(result.error).toContain('Unknown operator');
  });
});

describe('resolveExtractRule', () => {
  const doc = {
    response: {
      body: { id: 123, message: 'User created: id=456' },
      status: 200,
    },
  };

  it('extracts by simple string path', () => {
    const result = resolveExtractRule(doc, 'statusCode', 'response.status');
    expect(result).toBe('200');
  });

  it('extracts string value without JSON.stringify wrapping', () => {
    const result = resolveExtractRule({ name: 'Alice' }, 'username', 'name');
    expect(result).toBe('Alice');
  });

  it('extracts non-string value as JSON', () => {
    const result = resolveExtractRule(doc, 'bodyId', 'response.body.id');
    expect(result).toBe('123');
  });

  it('throws when path not found', () => {
    expect(() =>
      resolveExtractRule(doc, 'missing', 'response.missing'),
    ).toThrow("path 'response.missing' not found");
  });

  it('extracts with regex pattern (default group 1)', () => {
    const result = resolveExtractRule(doc, 'userId', {
      path: 'response.body.message',
      pattern: 'id=(\\d+)',
    });
    expect(result).toBe('456');
  });

  it('extracts with explicit capture group 0 (full match)', () => {
    const result = resolveExtractRule(doc, 'match', {
      path: 'response.body.message',
      pattern: 'id=\\d+',
      group: 0,
    });
    expect(result).toBe('id=456');
  });

  it('throws when regex pattern does not match', () => {
    expect(() =>
      resolveExtractRule(doc, 'x', {
        path: 'response.body.message',
        pattern: 'NOMATCH(\\d+)',
      }),
    ).toThrow('did not match');
  });

  it('throws when capture group is out of range', () => {
    expect(() =>
      resolveExtractRule(doc, 'x', {
        path: 'response.body.message',
        pattern: 'id=(\\d+)',
        group: 5,
      }),
    ).toThrow('capture group 5 out of range');
  });

  it('extracts object value as JSON string', () => {
    const result = resolveExtractRule(
      { data: { nested: { a: 1 } } },
      'obj',
      'data.nested',
    );
    expect(result).toBe('{"a":1}');
  });
});
