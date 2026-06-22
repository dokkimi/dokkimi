import {
  validateAssertionBlock,
  validateExtractRules,
  validateCountAssertion,
  validateMatchCriteria,
  validateWhereEntry,
} from './validate-assertions';
import { makeResult } from './test-helpers';

// ---------------------------------------------------------------------------
// validateExtractRules
// ---------------------------------------------------------------------------

describe('validateExtractRules', () => {
  it('accepts simple string paths with $. prefix', () => {
    const r = makeResult();
    validateExtractRules(
      { userId: '$.response.body.id', token: '$.response.headers.auth' },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('accepts paths starting with {{ (variable interpolation)', () => {
    const r = makeResult();
    validateExtractRules({ key: '{{dynamicPath}}' }, 'ctx', r);
    expect(r.errors).toHaveLength(0);
  });

  it('errors on extract path without $. prefix', () => {
    const r = makeResult();
    validateExtractRules({ userId: 'body.id' }, 'ctx', r);
    expect(r.errors.some((e) => e.includes('must start with "$."'))).toBe(true);
  });

  it('errors on deprecated $.body. path and suggests correction', () => {
    const r = makeResult();
    validateExtractRules({ userId: '$.body.id' }, 'ctx', r);
    expect(
      r.errors.some(
        (e) =>
          e.includes('deprecated format') &&
          e.includes('Did you mean "$.response.body."'),
      ),
    ).toBe(true);
  });

  it('errors on deprecated $.statusCode path and suggests correction', () => {
    const r = makeResult();
    validateExtractRules({ code: '$.statusCode' }, 'ctx', r);
    expect(
      r.errors.some(
        (e) =>
          e.includes('deprecated format') &&
          e.includes('Did you mean "$.response.status"'),
      ),
    ).toBe(true);
  });

  it('errors on deprecated $.extracted. path and suggests correction', () => {
    const r = makeResult();
    validateExtractRules({ val: '$.extracted.userId' }, 'ctx', r);
    expect(
      r.errors.some(
        (e) =>
          e.includes('deprecated format') &&
          e.includes('Did you mean "$.variables."'),
      ),
    ).toBe(true);
  });

  it('errors when extract is not an object', () => {
    const r = makeResult();
    validateExtractRules('bad', 'ctx', r);
    expect(r.errors[0]).toContain('"extract" must be an object');
  });

  it('errors when extract is an array', () => {
    const r = makeResult();
    validateExtractRules([], 'ctx', r);
    expect(r.errors[0]).toContain('"extract" must be an object');
  });

  it('errors when value is not a string or object', () => {
    const r = makeResult();
    validateExtractRules({ key: 123 }, 'ctx', r);
    expect(r.errors.some((e) => e.includes('must be a string'))).toBe(true);
  });

  describe('regex extract rules', () => {
    it('accepts a valid regex extract rule', () => {
      const r = makeResult();
      validateExtractRules(
        {
          orderId: {
            path: '$.response.body.message',
            pattern: 'id=(\\d+)',
            group: 1,
          },
        },
        'ctx',
        r,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('accepts regex rule without group (defaults to 1)', () => {
      const r = makeResult();
      validateExtractRules(
        {
          orderId: { path: '$.response.body.message', pattern: 'id=(\\d+)' },
        },
        'ctx',
        r,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('accepts group 0 for full match', () => {
      const r = makeResult();
      validateExtractRules(
        {
          ts: {
            path: '$.response.body.log',
            pattern: '\\d{4}-\\d{2}-\\d{2}',
            group: 0,
          },
        },
        'ctx',
        r,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors when path is missing', () => {
      const r = makeResult();
      validateExtractRules(
        {
          x: { pattern: '(\\d+)' },
        },
        'ctx',
        r,
      );
      expect(
        r.errors.some((e) => e.includes('"path" must be a non-empty string')),
      ).toBe(true);
    });

    it('errors when path is empty', () => {
      const r = makeResult();
      validateExtractRules(
        {
          x: { path: '', pattern: '(\\d+)' },
        },
        'ctx',
        r,
      );
      expect(
        r.errors.some((e) => e.includes('"path" must be a non-empty string')),
      ).toBe(true);
    });

    it('errors when pattern is missing', () => {
      const r = makeResult();
      validateExtractRules(
        {
          x: { path: '$.response.body.id' },
        },
        'ctx',
        r,
      );
      expect(
        r.errors.some((e) =>
          e.includes('"pattern" must be a non-empty string'),
        ),
      ).toBe(true);
    });

    it('errors on invalid regex pattern', () => {
      const r = makeResult();
      validateExtractRules(
        {
          x: { path: '$.response.body.id', pattern: '[invalid' },
        },
        'ctx',
        r,
      );
      expect(
        r.errors.some((e) => e.includes('"pattern" is not a valid regex')),
      ).toBe(true);
    });

    it('errors when group is negative', () => {
      const r = makeResult();
      validateExtractRules(
        {
          x: { path: '$.response.body.id', pattern: '(\\d+)', group: -1 },
        },
        'ctx',
        r,
      );
      expect(
        r.errors.some((e) =>
          e.includes('"group" must be a non-negative integer'),
        ),
      ).toBe(true);
    });

    it('errors when group is not an integer', () => {
      const r = makeResult();
      validateExtractRules(
        {
          x: { path: '$.response.body.id', pattern: '(\\d+)', group: 1.5 },
        },
        'ctx',
        r,
      );
      expect(
        r.errors.some((e) =>
          e.includes('"group" must be a non-negative integer'),
        ),
      ).toBe(true);
    });

    it('errors on regex rule path without $. prefix', () => {
      const r = makeResult();
      validateExtractRules(
        {
          x: { path: 'body.message', pattern: 'id=(\\d+)', group: 1 },
        },
        'ctx',
        r,
      );
      expect(r.errors.some((e) => e.includes('must start with "$."'))).toBe(
        true,
      );
    });

    it('warns on unknown keys in regex rule', () => {
      const r = makeResult();
      validateExtractRules(
        {
          x: { path: '$.response.body.id', pattern: '(\\d+)', bogus: true },
        },
        'ctx',
        r,
      );
      expect(r.warnings.some((w) => w.includes('unknown key "bogus"'))).toBe(
        true,
      );
    });
  });

  describe('transform extract rules', () => {
    it('accepts a valid transform extract with path + transform: "keys"', () => {
      const r = makeResult();
      validateExtractRules(
        {
          result: {
            path: '$.response.body.data',
            transform: 'keys',
          },
        },
        'ctx',
        r,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('accepts a valid transform extract with from + transform: "values"', () => {
      const r = makeResult();
      validateExtractRules(
        {
          result: {
            from: 'myVar',
            transform: 'values',
          },
        },
        'ctx',
        r,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('accepts a valid transform extract with transform: "entries"', () => {
      const r = makeResult();
      validateExtractRules(
        {
          result: {
            path: '$.response.body.config',
            transform: 'entries',
          },
        },
        'ctx',
        r,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors when transform has both path and from', () => {
      const r = makeResult();
      validateExtractRules(
        {
          result: {
            path: '$.response.body.data',
            from: 'myVar',
            transform: 'keys',
          },
        },
        'ctx',
        r,
      );
      expect(
        r.errors.some((e) =>
          e.includes('"from" and "path" are mutually exclusive'),
        ),
      ).toBe(true);
    });

    it('errors when transform has neither path nor from', () => {
      const r = makeResult();
      validateExtractRules(
        {
          result: {
            transform: 'keys',
          },
        },
        'ctx',
        r,
      );
      expect(
        r.errors.some((e) => e.includes('"path" must be a non-empty string')),
      ).toBe(true);
    });

    it('errors when transform value is not one of keys/values/entries', () => {
      const r = makeResult();
      validateExtractRules(
        {
          result: {
            path: '$.response.body.data',
            transform: 'bogus',
          },
        },
        'ctx',
        r,
      );
      expect(
        r.errors.some((e) =>
          e.includes('"transform" must be one of: keys, values, entries'),
        ),
      ).toBe(true);
    });

    it('errors when transform path does not start with $.', () => {
      const r = makeResult();
      validateExtractRules(
        {
          result: {
            path: 'response.body.data',
            transform: 'keys',
          },
        },
        'ctx',
        r,
      );
      expect(r.errors.some((e) => e.includes('must start with "$."'))).toBe(
        true,
      );
    });
  });

  it('accepts mixed simple and regex rules', () => {
    const r = makeResult();
    validateExtractRules(
      {
        simple: '$.response.body.id',
        regex: { path: '$.response.body.msg', pattern: 'id=(\\d+)', group: 1 },
      },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateCountAssertion
// ---------------------------------------------------------------------------

describe('validateCountAssertion', () => {
  it('accepts a valid count assertion', () => {
    const r = makeResult();
    validateCountAssertion({ operator: 'eq', value: 1 }, 'ctx', r);
    expect(r.errors).toHaveLength(0);
  });

  it('accepts all valid operators', () => {
    for (const op of ['eq', 'gte', 'lte', 'gt', 'lt']) {
      const r = makeResult();
      validateCountAssertion({ operator: op, value: 0 }, 'ctx', r);
      expect(r.errors).toHaveLength(0);
    }
  });

  it('errors when count is not an object', () => {
    const r = makeResult();
    validateCountAssertion('bad', 'ctx', r);
    expect(r.errors[0]).toContain('must be an object');
  });

  it('errors on invalid operator', () => {
    const r = makeResult();
    validateCountAssertion({ operator: 'bogus', value: 1 }, 'ctx', r);
    expect(r.errors.some((e) => e.includes('operator must be one of'))).toBe(
      true,
    );
  });

  it('errors when value is not an integer', () => {
    const r = makeResult();
    validateCountAssertion({ operator: 'eq', value: 'one' }, 'ctx', r);
    expect(r.errors.some((e) => e.includes('value must be an integer'))).toBe(
      true,
    );
  });

  it('errors when value is a float', () => {
    const r = makeResult();
    validateCountAssertion({ operator: 'eq', value: 1.5 }, 'ctx', r);
    expect(r.errors.some((e) => e.includes('value must be an integer'))).toBe(
      true,
    );
  });

  it('warns on unknown keys', () => {
    const r = makeResult();
    validateCountAssertion({ operator: 'eq', value: 1, extra: true }, 'ctx', r);
    expect(r.warnings.some((w) => w.includes('unknown property'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateWhereEntry
// ---------------------------------------------------------------------------

describe('validateWhereEntry', () => {
  it('accepts a valid assertion-form where entry', () => {
    const r = makeResult();
    validateWhereEntry(
      { path: '$$.origin', operator: 'eq', value: 'svc-a' },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('errors when path does not start with $$.', () => {
    const r = makeResult();
    validateWhereEntry(
      { path: '$.origin', operator: 'eq', value: 'svc-a' },
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('must start with "$$."'))).toBe(
      true,
    );
  });

  it('errors when entry is not an object', () => {
    const r = makeResult();
    validateWhereEntry('bad', 'ctx', r);
    expect(r.errors[0]).toContain('must be an object');
  });

  it('errors when no form is specified', () => {
    const r = makeResult();
    validateWhereEntry({}, 'ctx', r);
    expect(r.errors.some((e) => e.includes('must have one of'))).toBe(true);
  });

  it('accepts or combinator', () => {
    const r = makeResult();
    validateWhereEntry(
      {
        or: [
          { path: '$$.origin', operator: 'eq', value: 'a' },
          { path: '$$.origin', operator: 'eq', value: 'b' },
        ],
      },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('errors when or is empty', () => {
    const r = makeResult();
    validateWhereEntry({ or: [] }, 'ctx', r);
    expect(r.errors.some((e) => e.includes('must be a non-empty array'))).toBe(
      true,
    );
  });

  it('accepts and combinator', () => {
    const r = makeResult();
    validateWhereEntry(
      {
        and: [
          { path: '$$.method', operator: 'eq', value: 'POST' },
          { path: '$$.origin', operator: 'eq', value: 'svc-a' },
        ],
      },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('accepts not combinator', () => {
    const r = makeResult();
    validateWhereEntry(
      { not: { path: '$$.origin', operator: 'eq', value: 'svc-a' } },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('recurses into nested or entries', () => {
    const r = makeResult();
    validateWhereEntry(
      {
        or: [{ path: 'bad', operator: 'eq', value: 'x' }],
      },
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('must start with "$$."'))).toBe(
      true,
    );
  });

  it('errors on invalid operator in assertion form', () => {
    const r = makeResult();
    validateWhereEntry(
      { path: '$$.origin', operator: 'bogus', value: 'x' },
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('operator must be one of'))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// validateMatchCriteria
// ---------------------------------------------------------------------------

describe('validateMatchCriteria', () => {
  it('accepts a valid match with path and where', () => {
    const r = makeResult();
    validateMatchCriteria(
      {
        path: '$.traffic',
        where: [{ path: '$$.origin', operator: 'eq', value: 'svc-a' }],
      },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('accepts match with only path (no where = match all)', () => {
    const r = makeResult();
    validateMatchCriteria({ path: '$.traffic' }, 'ctx', r);
    expect(r.errors).toHaveLength(0);
  });

  it('errors when path is missing', () => {
    const r = makeResult();
    validateMatchCriteria({ where: [] }, 'ctx', r);
    expect(r.errors.some((e) => e.includes('"path" is required'))).toBe(true);
  });

  it('errors when path does not start with $.', () => {
    const r = makeResult();
    validateMatchCriteria({ path: 'traffic' }, 'ctx', r);
    expect(r.errors.some((e) => e.includes('must start with "$."'))).toBe(true);
  });

  it('errors when match is not an object', () => {
    const r = makeResult();
    validateMatchCriteria('bad', 'ctx', r);
    expect(r.errors.some((e) => e.includes('"match" must be an object'))).toBe(
      true,
    );
  });

  it('accepts count as a number', () => {
    const r = makeResult();
    validateMatchCriteria({ path: '$.traffic', count: 3 }, 'ctx', r);
    expect(r.errors).toHaveLength(0);
  });

  it('accepts count as an object', () => {
    const r = makeResult();
    validateMatchCriteria(
      { path: '$.traffic', count: { operator: 'gte', value: 1 } },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('errors on negative count number', () => {
    const r = makeResult();
    validateMatchCriteria({ path: '$.traffic', count: -1 }, 'ctx', r);
    expect(
      r.errors.some((e) => e.includes('must be a non-negative integer')),
    ).toBe(true);
  });

  it('accepts as field', () => {
    const r = makeResult();
    validateMatchCriteria({ path: '$.traffic', as: 'myMatches' }, 'ctx', r);
    expect(r.errors).toHaveLength(0);
  });

  it('errors when as is empty string', () => {
    const r = makeResult();
    validateMatchCriteria({ path: '$.traffic', as: '' }, 'ctx', r);
    expect(r.errors.some((e) => e.includes('"as" must be a non-empty'))).toBe(
      true,
    );
  });

  it('warns on unknown keys', () => {
    const r = makeResult();
    validateMatchCriteria({ path: '$.traffic', bogus: true }, 'ctx', r);
    expect(r.warnings.some((w) => w.includes('unknown property'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateAssertionBlock
// ---------------------------------------------------------------------------

describe('validateAssertionBlock', () => {
  it('accepts a valid assertion block', () => {
    const r = makeResult();
    validateAssertionBlock(
      {
        assertions: [{ path: '$.response.status', operator: 'eq', value: 200 }],
      },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('errors when match is not an object', () => {
    const r = makeResult();
    validateAssertionBlock({ match: 'bad' }, 'ctx', r);
    expect(r.errors.some((e) => e.includes('"match" must be an object'))).toBe(
      true,
    );
  });

  it('accepts valid match criteria', () => {
    const r = makeResult();
    validateAssertionBlock(
      {
        match: {
          path: '$.traffic',
          where: [{ path: '$$.origin', operator: 'eq', value: 'svc-a' }],
        },
        assertions: [
          { path: '$.match.response.status', operator: 'eq', value: 200 },
        ],
      },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('validates extract in assertion block', () => {
    const r = makeResult();
    validateAssertionBlock(
      {
        extract: { id: '$.response.body.id' },
      },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('errors when extract is not an object', () => {
    const r = makeResult();
    validateAssertionBlock({ extract: 'bad' }, 'ctx', r);
    expect(
      r.errors.some((e) => e.includes('"extract" must be an object')),
    ).toBe(true);
  });

  it('errors on invalid assertion operator', () => {
    const r = makeResult();
    validateAssertionBlock(
      {
        assertions: [
          { path: '$.response.status', operator: 'bogus', value: 200 },
        ],
      },
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('operator must be one of'))).toBe(
      true,
    );
  });

  it('errors when assertions is not an array', () => {
    const r = makeResult();
    validateAssertionBlock({ assertions: 'bad' }, 'ctx', r);
    expect(
      r.errors.some((e) => e.includes('"assertions" must be an array')),
    ).toBe(true);
  });

  it('warns on unknown keys', () => {
    const r = makeResult();
    validateAssertionBlock({ bogus: true }, 'ctx', r);
    expect(r.warnings.some((w) => w.includes('unknown property "bogus"'))).toBe(
      true,
    );
  });

  describe('assertion source fields', () => {
    it('accepts assertion with path string', () => {
      const r = makeResult();
      validateAssertionBlock(
        {
          assertions: [
            { path: '$.response.status', operator: 'eq', value: 200 },
          ],
        },
        'ctx',
        r,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('accepts assertion with path object (PathWithTransform)', () => {
      const r = makeResult();
      validateAssertionBlock(
        {
          assertions: [
            {
              path: { from: '$.response.body.items', transform: 'length' },
              operator: 'eq',
              value: 3,
            },
          ],
        },
        'ctx',
        r,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('accepts assertion with count shorthand', () => {
      const r = makeResult();
      validateAssertionBlock(
        {
          assertions: [{ count: '$.traffic', operator: 'gte', value: 1 }],
        },
        'ctx',
        r,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('accepts assertion with type shorthand', () => {
      const r = makeResult();
      validateAssertionBlock(
        {
          assertions: [
            { type: '$.response.body.id', operator: 'eq', value: 'number' },
          ],
        },
        'ctx',
        r,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors when no source field is present', () => {
      const r = makeResult();
      validateAssertionBlock(
        {
          assertions: [{ operator: 'eq', value: 200 }],
        },
        'ctx',
        r,
      );
      expect(
        r.errors.some((e) => e.includes('must have exactly one source field')),
      ).toBe(true);
    });

    it('errors when multiple source fields are present', () => {
      const r = makeResult();
      validateAssertionBlock(
        {
          assertions: [{ path: '$.x', count: '$.y', operator: 'eq', value: 1 }],
        },
        'ctx',
        r,
      );
      expect(
        r.errors.some((e) => e.includes('only one source field allowed')),
      ).toBe(true);
    });
  });

  describe('forEach', () => {
    it('accepts a valid forEach with inline items array and nested assertions', () => {
      const r = makeResult();
      validateAssertionBlock(
        {
          forEach: {
            items: ['a', 'b', 'c'],
            as: 'item',
            assertions: [
              { path: '$.response.status', operator: 'eq', value: 200 },
            ],
          },
        },
        'ctx',
        r,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('accepts forEach with a {{variable}} string reference for items', () => {
      const r = makeResult();
      validateAssertionBlock(
        {
          forEach: {
            items: '{{myList}}',
            as: 'item',
            assertions: [
              { path: '$.response.status', operator: 'eq', value: 200 },
            ],
          },
        },
        'ctx',
        r,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors when forEach is missing items', () => {
      const r = makeResult();
      validateAssertionBlock(
        {
          forEach: { as: 'item' },
        },
        'ctx',
        r,
      );
      expect(r.errors.some((e) => e.includes('"items" is required'))).toBe(
        true,
      );
    });

    it('errors when forEach is missing as', () => {
      const r = makeResult();
      validateAssertionBlock(
        {
          forEach: { items: [1, 2, 3] },
        },
        'ctx',
        r,
      );
      expect(
        r.errors.some((e) =>
          e.includes('"as" is required and must be a non-empty string'),
        ),
      ).toBe(true);
    });

    it('errors when as is not a valid identifier', () => {
      const r = makeResult();
      validateAssertionBlock(
        {
          forEach: { items: [1, 2], as: 'not valid!' },
        },
        'ctx',
        r,
      );
      expect(
        r.errors.some((e) => e.includes('"as" must be alphanumeric')),
      ).toBe(true);
    });

    it('accepts forEach with optional name and delayMs', () => {
      const r = makeResult();
      validateAssertionBlock(
        {
          forEach: {
            items: ['x', 'y'],
            as: 'val',
            name: 'myLoop',
            delayMs: 100,
            assertions: [
              { path: '$.response.status', operator: 'eq', value: 200 },
            ],
          },
        },
        'ctx',
        r,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors when assertions are a sibling of forEach', () => {
      const r = makeResult();
      validateAssertionBlock(
        {
          forEach: { items: ['a', 'b'], as: 'item' },
          assertions: [
            { path: '$.response.status', operator: 'eq', value: 200 },
          ],
        },
        'ctx',
        r,
      );
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toContain(
        '"assertions" must be inside "forEach" body',
      );
    });
  });

  describe('ValueRef detection', () => {
    it('treats value with $.-prefixed from as ValueRef (no error)', () => {
      const r = makeResult();
      validateAssertionBlock(
        {
          assertions: [
            {
              path: '$.response.status',
              operator: 'eq',
              value: { from: '$.variables.expected' },
            },
          ],
        },
        'ctx',
        r,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('treats value with non-$. from as literal object (no error)', () => {
      const r = makeResult();
      validateAssertionBlock(
        {
          assertions: [
            {
              path: '$.response.body.price',
              operator: 'eq',
              value: { from: '$50', to: '$100' },
            },
          ],
        },
        'ctx',
        r,
      );
      expect(r.errors).toHaveLength(0);
    });
  });

  describe('path format validation', () => {
    it('rejects $$ prefix in assertion path (only valid in where)', () => {
      const r = makeResult();
      validateAssertionBlock(
        {
          assertions: [
            { path: '$$.origin', operator: 'eq', value: 'service-a' },
          ],
        },
        'ctx',
        r,
      );
      expect(r.errors.some((e) => e.includes('only valid inside where'))).toBe(
        true,
      );
    });

    it('errors on assertion path without $. prefix', () => {
      const r = makeResult();
      validateAssertionBlock(
        {
          assertions: [{ path: 'response.status', operator: 'eq', value: 200 }],
        },
        'ctx',
        r,
      );
      expect(r.errors.some((e) => e.includes('must start with "$."'))).toBe(
        true,
      );
    });

    it('suggests correction for old response.body path', () => {
      const r = makeResult();
      validateAssertionBlock(
        {
          assertions: [
            { path: 'response.body.name', operator: 'eq', value: 'Alice' },
          ],
        },
        'ctx',
        r,
      );
      expect(
        r.errors.some((e) => e.includes('Did you mean "$.response.body."')),
      ).toBe(true);
    });

    it('suggests correction for old bare DB paths', () => {
      const r = makeResult();
      validateAssertionBlock(
        {
          assertions: [{ path: 'success', operator: 'eq', value: true }],
        },
        'ctx',
        r,
      );
      expect(
        r.errors.some((e) => e.includes('Did you mean "$.response.success"')),
      ).toBe(true);
    });

    it('suggests correction for old data[] path', () => {
      const r = makeResult();
      validateAssertionBlock(
        {
          assertions: [
            { path: 'data[0].email', operator: 'eq', value: 'a@b.com' },
          ],
        },
        'ctx',
        r,
      );
      expect(
        r.errors.some((e) => e.includes('Did you mean "$.response.data["')),
      ).toBe(true);
    });

    it('suggests correction for old responseTime path', () => {
      const r = makeResult();
      validateAssertionBlock(
        {
          assertions: [{ path: 'responseTime', operator: 'lt', value: 500 }],
        },
        'ctx',
        r,
      );
      expect(
        r.errors.some((e) => e.includes('Did you mean "$.responseTime"')),
      ).toBe(true);
    });

    it('suggests correction for old request. path', () => {
      const r = makeResult();
      validateAssertionBlock(
        {
          assertions: [
            { path: 'request.method', operator: 'eq', value: 'POST' },
          ],
        },
        'ctx',
        r,
      );
      expect(
        r.errors.some((e) => e.includes('Did you mean "$.request."')),
      ).toBe(true);
    });

    it('accepts paths starting with {{ (variable interpolation)', () => {
      const r = makeResult();
      validateAssertionBlock(
        {
          assertions: [
            { path: '{{dynamicPath}}', operator: 'eq', value: 'test' },
          ],
        },
        'ctx',
        r,
      );
      expect(r.errors).toHaveLength(0);
    });
  });
});
