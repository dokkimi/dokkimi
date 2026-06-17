import { validateDefinition } from './validate';
import { makeResult, makeMockFs } from './test-helpers';

// ---------------------------------------------------------------------------
// validateDefinition
// ---------------------------------------------------------------------------

describe('validateDefinition', () => {
  const serviceFragment = JSON.stringify({
    type: 'SERVICE',
    name: 'svc',
    image: 'img',
    port: 3000,
    healthCheck: '/h',
  });
  const fs = makeMockFs({ '/shared/svc.json': serviceFragment });

  it('validates a minimal valid definition', () => {
    const r = makeResult();
    validateDefinition(
      {
        name: 'my-def',
        items: [{ type: 'DATABASE', name: 'pg', database: 'postgres' }],
      },
      '/defs/test.json',
      r,
      fs,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('errors on missing name', () => {
    const r = makeResult();
    validateDefinition({ items: [] }, '/f.json', r, fs);
    expect(r.errors.some((e) => e.includes('missing or empty "name"'))).toBe(
      true,
    );
  });

  it('errors on name exceeding max length', () => {
    const r = makeResult();
    validateDefinition({ name: 'a'.repeat(101), items: [] }, '/f.json', r, fs);
    expect(r.errors.some((e) => e.includes('exceeds'))).toBe(true);
  });

  it('errors when items is not an array', () => {
    const r = makeResult();
    validateDefinition({ name: 'def', items: 'bad' }, '/f.json', r, fs);
    expect(r.errors.some((e) => e.includes('"items" must be an array'))).toBe(
      true,
    );
  });

  it('warns on empty items', () => {
    const r = makeResult();
    validateDefinition({ name: 'def', items: [] }, '/f.json', r, fs);
    expect(r.warnings.some((w) => w.includes('"items" is empty'))).toBe(true);
  });

  it('errors on duplicate item names', () => {
    const r = makeResult();
    validateDefinition(
      {
        name: 'def',
        items: [
          { type: 'DATABASE', name: 'pg', database: 'postgres' },
          { type: 'DATABASE', name: 'pg', database: 'mysql' },
        ],
      },
      '/f.json',
      r,
      fs,
    );
    expect(r.errors.some((e) => e.includes('duplicate item name'))).toBe(true);
  });

  it('resolves $ref items', () => {
    const r = makeResult();
    validateDefinition(
      { name: 'def', items: [{ $ref: '../shared/svc.json' }] },
      '/defs/test.json',
      r,
      fs,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('validates tests when present', () => {
    const r = makeResult();
    validateDefinition(
      {
        name: 'def',
        items: [{ type: 'DATABASE', name: 'pg', database: 'postgres' }],
        tests: [{ name: 'test', steps: [] }],
      },
      '/f.json',
      r,
      fs,
    );
    expect(r.errors).toHaveLength(0);
  });

  describe('config block', () => {
    it('accepts valid config with timeoutSeconds', () => {
      const r = makeResult();
      validateDefinition(
        { name: 'def', items: [], config: { timeoutSeconds: 300 } },
        '/f.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors on invalid config.timeoutSeconds', () => {
      const r = makeResult();
      validateDefinition(
        { name: 'def', items: [], config: { timeoutSeconds: -1 } },
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) =>
          e.includes('config.timeoutSeconds must be a positive integer'),
        ),
      ).toBe(true);
    });

    it('errors on non-integer config.timeoutSeconds', () => {
      const r = makeResult();
      validateDefinition(
        { name: 'def', items: [], config: { timeoutSeconds: 1.5 } },
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) =>
          e.includes('config.timeoutSeconds must be a positive integer'),
        ),
      ).toBe(true);
    });

    it('errors when config is not an object', () => {
      const r = makeResult();
      validateDefinition(
        { name: 'def', items: [], config: 'bad' },
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) => e.includes('"config" must be a plain object')),
      ).toBe(true);
    });

    it('accepts valid browser config', () => {
      const r = makeResult();
      validateDefinition(
        {
          name: 'def',
          items: [],
          config: { browser: { version: '148.0.7778.56' } },
        },
        '/f.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors on unknown browser keys', () => {
      const r = makeResult();
      validateDefinition(
        {
          name: 'def',
          items: [],
          config: { browser: { name: 'chrome', version: '148.0.7778.56' } },
        },
        '/f.json',
        r,
        fs,
      );
      expect(
        r.warnings.some((w) => w.includes('unknown property "name"')),
      ).toBe(true);
    });

    it('errors on empty browser version', () => {
      const r = makeResult();
      validateDefinition(
        {
          name: 'def',
          items: [],
          config: { browser: { version: '' } },
        },
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) =>
          e.includes('config.browser.version must be a non-empty string'),
        ),
      ).toBe(true);
    });

    it('warns on unknown config keys', () => {
      const r = makeResult();
      validateDefinition(
        { name: 'def', items: [], config: { unknownKey: true } },
        '/f.json',
        r,
        fs,
      );
      expect(
        r.warnings.some((w) => w.includes('unknown property "unknownKey"')),
      ).toBe(true);
    });
  });

  describe('definition-level variables', () => {
    it('accepts valid inline variables', () => {
      const r = makeResult();
      validateDefinition(
        {
          name: 'def',
          items: [{ type: 'DATABASE', name: 'pg', database: 'postgres' }],
          variables: {
            pgConnStr: 'postgres://localhost',
            redisUrl: 'redis://localhost',
          },
        },
        '/f.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('does not warn on "variables" as unknown property', () => {
      const r = makeResult();
      validateDefinition(
        { name: 'def', items: [], variables: { key: 'val' } },
        '/f.json',
        r,
        fs,
      );
      expect(
        r.warnings.some((w) => w.includes('unknown property "variables"')),
      ).toBe(false);
    });

    it('errors when variables is not an object', () => {
      const r = makeResult();
      validateDefinition(
        { name: 'def', items: [], variables: 'bad' },
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) => e.includes('"variables" must be a plain object')),
      ).toBe(true);
    });

    it('errors on non-alphanumeric variable key', () => {
      const r = makeResult();
      validateDefinition(
        { name: 'def', items: [], variables: { 'bad-key': 'val' } },
        '/f.json',
        r,
        fs,
      );
      expect(r.errors.some((e) => e.includes('must be alphanumeric'))).toBe(
        true,
      );
    });

    it('accepts non-string variable values', () => {
      const r = makeResult();
      validateDefinition(
        { name: 'def', items: [], variables: { key: 123, arr: [1, 2] } },
        '/f.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
    });
  });
});
