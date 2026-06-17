import {
  validateAssertionBlock,
  validateExtractRules,
  validateCountAssertion,
  validateConsoleLogAssertion,
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
    expect(
      r.errors.some((e) =>
        e.includes('must be a string or { path, pattern, group? }'),
      ),
    ).toBe(true);
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
// validateConsoleLogAssertion
// ---------------------------------------------------------------------------

describe('validateConsoleLogAssertion', () => {
  it('accepts a valid console log assertion', () => {
    const r = makeResult();
    validateConsoleLogAssertion(
      {
        level: 'INFO',
        message: { operator: 'contains', value: 'hello' },
        count: { operator: 'gte', value: 1 },
      },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('accepts all valid levels', () => {
    for (const level of ['INFO', 'WARN', 'ERROR', 'DEBUG']) {
      const r = makeResult();
      validateConsoleLogAssertion(
        {
          level,
          count: { operator: 'eq', value: 0 },
        },
        'ctx',
        r,
      );
      expect(r.errors).toHaveLength(0);
    }
  });

  it('errors when not an object', () => {
    const r = makeResult();
    validateConsoleLogAssertion('bad', 'ctx', r);
    expect(r.errors[0]).toContain('must be an object');
  });

  it('errors on invalid level', () => {
    const r = makeResult();
    validateConsoleLogAssertion(
      {
        level: 'TRACE',
        count: { operator: 'eq', value: 0 },
      },
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('level must be one of'))).toBe(true);
  });

  it('errors when message is not an object', () => {
    const r = makeResult();
    validateConsoleLogAssertion(
      {
        message: 'bad',
        count: { operator: 'eq', value: 0 },
      },
      'ctx',
      r,
    );
    expect(
      r.errors.some((e) => e.includes('"message" must be an object')),
    ).toBe(true);
  });

  it('errors on invalid message operator', () => {
    const r = makeResult();
    validateConsoleLogAssertion(
      {
        message: { operator: 'bogus', value: 'hi' },
        count: { operator: 'eq', value: 0 },
      },
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('operator must be one of'))).toBe(
      true,
    );
  });

  it('errors when message value is not a string', () => {
    const r = makeResult();
    validateConsoleLogAssertion(
      {
        message: { operator: 'contains', value: 123 },
        count: { operator: 'eq', value: 0 },
      },
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('value must be a string'))).toBe(
      true,
    );
  });

  it('validates nested count assertion', () => {
    const r = makeResult();
    validateConsoleLogAssertion(
      {
        count: { operator: 'bogus', value: 1 },
      },
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('operator must be one of'))).toBe(
      true,
    );
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

  it('errors on invalid assertionScope', () => {
    const r = makeResult();
    validateAssertionBlock({ assertionScope: 'bogus' }, 'ctx', r);
    expect(
      r.errors.some((e) => e.includes('assertionScope must be one of')),
    ).toBe(true);
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
        match: { origin: 'svc-a', method: 'POST', url: 'svc-b/api' },
        assertions: [{ path: '$.response.status', operator: 'eq', value: 200 }],
      },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('warns when match url contains a port', () => {
    const r = makeResult();
    validateAssertionBlock(
      {
        match: { url: 'svc:3000/api' },
      },
      'ctx',
      r,
    );
    expect(r.warnings.some((w) => w.includes('contains a port'))).toBe(true);
  });

  it('validates count in assertion block', () => {
    const r = makeResult();
    validateAssertionBlock(
      {
        match: { origin: 'svc' },
        count: { operator: 'eq', value: 1 },
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

  it('validates consoleAssertions', () => {
    const r = makeResult();
    validateAssertionBlock(
      {
        consoleAssertions: [
          {
            level: 'INFO',
            count: { operator: 'gte', value: 1 },
          },
        ],
      },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('errors when consoleAssertions is not an array', () => {
    const r = makeResult();
    validateAssertionBlock({ consoleAssertions: 'bad' }, 'ctx', r);
    expect(
      r.errors.some((e) => e.includes('"consoleAssertions" must be an array')),
    ).toBe(true);
  });

  it('warns on unknown keys', () => {
    const r = makeResult();
    validateAssertionBlock({ bogus: true }, 'ctx', r);
    expect(r.warnings.some((w) => w.includes('unknown property "bogus"'))).toBe(
      true,
    );
  });

  describe('path format validation', () => {
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
