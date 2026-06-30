import {
  validateTests,
  validateStep,
  resolveVariablesRef,
} from './validate-tests';
import { makeResult, makeMockFs } from './test-helpers';

// ---------------------------------------------------------------------------
// validateTests
// ---------------------------------------------------------------------------

describe('validateTests', () => {
  const defFile = '/defs/test.json';
  const mockFs = makeMockFs();

  it('validates a minimal valid test', () => {
    const r = makeResult();
    validateTests([{ name: 'my-test', steps: [] }], r, defFile, mockFs);
    expect(r.errors).toHaveLength(0);
  });

  it('errors when tests is not an array', () => {
    const r = makeResult();
    validateTests('bad', r, defFile, mockFs);
    expect(r.errors[0]).toContain('"tests" must be an array');
  });

  it('warns on legacy object format', () => {
    const r = makeResult();
    validateTests({ legacy: true }, r, defFile, mockFs);
    expect(r.warnings.some((w) => w.includes('legacy'))).toBe(true);
  });

  it('errors when test entry is not an object', () => {
    const r = makeResult();
    validateTests(['bad'], r, defFile, mockFs);
    expect(r.errors[0]).toContain('must be an object');
  });

  it('errors on missing test name', () => {
    const r = makeResult();
    validateTests([{ steps: [] }], r, defFile, mockFs);
    expect(r.errors.some((e) => e.includes('missing or empty "name"'))).toBe(
      true,
    );
  });

  it('warns on unknown test keys', () => {
    const r = makeResult();
    validateTests(
      [{ name: 'test', steps: [], bogus: true }],
      r,
      defFile,
      mockFs,
    );
    expect(r.warnings.some((w) => w.includes('unknown property "bogus"'))).toBe(
      true,
    );
  });

  describe('variables', () => {
    it('accepts valid variables', () => {
      const r = makeResult();
      validateTests(
        [{ name: 'test', variables: { myVar: 'value' } }],
        r,
        defFile,
        mockFs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors when variables is not an object', () => {
      const r = makeResult();
      validateTests([{ name: 'test', variables: 'bad' }], r, defFile, mockFs);
      expect(
        r.errors.some((e) => e.includes('"variables" must be a plain object')),
      ).toBe(true);
    });

    it('errors on non-alphanumeric variable key', () => {
      const r = makeResult();
      validateTests(
        [{ name: 'test', variables: { 'bad-key': 'val' } }],
        r,
        defFile,
        mockFs,
      );
      expect(r.errors.some((e) => e.includes('must be alphanumeric'))).toBe(
        true,
      );
    });

    it('accepts non-string variable values (numbers, arrays, objects)', () => {
      const r = makeResult();
      validateTests(
        [
          {
            name: 'test',
            variables: {
              num: 42,
              arr: [1, 2, 3],
              obj: { nested: true },
              flag: true,
            },
          },
        ],
        r,
        defFile,
        mockFs,
      );
      expect(r.errors).toHaveLength(0);
    });
  });

  describe('steps structure', () => {
    it('errors when steps is not an array', () => {
      const r = makeResult();
      validateTests([{ name: 'test', steps: 'bad' }], r, defFile, mockFs);
      expect(r.errors.some((e) => e.includes('"steps" must be an array'))).toBe(
        true,
      );
    });

    it('validates flat steps', () => {
      const r = makeResult();
      validateTests(
        [
          {
            name: 'test',
            steps: [
              { action: { type: 'httpRequest', method: 'GET', url: '/api' } },
            ],
          },
        ],
        r,
        defFile,
        mockFs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('validates multiple sequential steps', () => {
      const r = makeResult();
      validateTests(
        [
          {
            name: 'test',
            steps: [
              { action: { type: 'httpRequest', method: 'GET', url: '/api' } },
              { action: { type: 'wait', durationMs: 500 } },
              {
                action: { type: 'dbQuery', database: 'pg', query: 'SELECT 1' },
              },
            ],
          },
        ],
        r,
        defFile,
        mockFs,
      );
      expect(r.errors).toHaveLength(0);
    });
  });

  describe('parallel action type', () => {
    it('validates a parallel action with valid sub-actions', () => {
      const r = makeResult();
      validateTests(
        [
          {
            name: 'test',
            steps: [
              {
                action: {
                  type: 'parallel',
                  actions: [
                    { type: 'httpRequest', method: 'GET', url: '/api' },
                    { type: 'httpRequest', method: 'POST', url: '/other' },
                  ],
                },
              },
            ],
          },
        ],
        r,
        defFile,
        mockFs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors when parallel actions is not an array', () => {
      const r = makeResult();
      validateTests(
        [
          {
            name: 'test',
            steps: [
              {
                action: {
                  type: 'parallel',
                  actions: 'bad',
                },
              },
            ],
          },
        ],
        r,
        defFile,
        mockFs,
      );
      expect(
        r.errors.some((e) => e.includes('parallel requires "actions" array')),
      ).toBe(true);
    });

    it('validates sub-actions within a parallel action', () => {
      const r = makeResult();
      validateTests(
        [
          {
            name: 'test',
            steps: [
              {
                action: {
                  type: 'parallel',
                  actions: [
                    { type: 'httpRequest', url: '/api' }, // missing method
                  ],
                },
              },
            ],
          },
        ],
        r,
        defFile,
        mockFs,
      );
      expect(r.errors.some((e) => e.includes('requires valid "method"'))).toBe(
        true,
      );
    });

    it('accepts a single UI action in a parallel action', () => {
      const r = makeResult();
      validateTests(
        [
          {
            name: 'test',
            steps: [
              {
                action: {
                  type: 'parallel',
                  actions: [
                    {
                      type: 'ui',
                      target: 'frontend-svc',
                      steps: [{ visit: '/' }],
                    },
                    { type: 'httpRequest', method: 'GET', url: '/api' },
                  ],
                },
              },
            ],
          },
        ],
        r,
        defFile,
        mockFs,
      );
      expect(r.errors.some((e) => e.includes('more than one UI action'))).toBe(
        false,
      );
    });

    it('errors on two UI actions in a parallel action', () => {
      const r = makeResult();
      validateTests(
        [
          {
            name: 'test',
            steps: [
              {
                action: {
                  type: 'parallel',
                  actions: [
                    {
                      type: 'ui',
                      target: 'frontend-svc',
                      steps: [{ visit: '/' }],
                    },
                    {
                      type: 'ui',
                      target: 'admin-svc',
                      steps: [{ visit: '/' }],
                    },
                  ],
                },
              },
            ],
          },
        ],
        r,
        defFile,
        mockFs,
      );
      expect(
        r.errors.some((e) =>
          e.includes('parallel cannot have more than one UI action'),
        ),
      ).toBe(true);
    });
  });

  describe('parallel step warnings', () => {
    it('warns when extract is used on a parallel step', () => {
      const r = makeResult();
      validateTests(
        [
          {
            name: 'test',
            steps: [
              {
                action: {
                  type: 'parallel',
                  actions: [
                    { type: 'httpRequest', method: 'GET', url: '/api' },
                  ],
                },
                extract: { id: '$.response.body.id' },
              },
            ],
          },
        ],
        r,
        defFile,
        mockFs,
      );
      expect(
        r.warnings.some((w) =>
          w.includes(
            '"extract" on a parallel step will always receive an empty response',
          ),
        ),
      ).toBe(true);
    });

    it('warns when self-block assertions are used on a parallel step', () => {
      const r = makeResult();
      validateTests(
        [
          {
            name: 'test',
            steps: [
              {
                action: {
                  type: 'parallel',
                  actions: [
                    { type: 'httpRequest', method: 'GET', url: '/api' },
                  ],
                },
                assertions: [
                  {
                    assertions: [
                      { path: '$.response.status', operator: 'eq', value: 200 },
                    ],
                  },
                ],
              },
            ],
          },
        ],
        r,
        defFile,
        mockFs,
      );
      expect(
        r.warnings.some((w) =>
          w.includes('self-block assertions on a parallel step'),
        ),
      ).toBe(true);
    });

    it('does not warn when only match-block assertions are used on a parallel step', () => {
      const r = makeResult();
      validateTests(
        [
          {
            name: 'test',
            steps: [
              {
                action: {
                  type: 'parallel',
                  actions: [
                    { type: 'httpRequest', method: 'GET', url: '/api' },
                  ],
                },
                assertions: [
                  {
                    match: { origin: 'svc-a' },
                    assertions: [
                      { path: '$.response.status', operator: 'eq', value: 200 },
                    ],
                  },
                ],
              },
            ],
          },
        ],
        r,
        defFile,
        mockFs,
      );
      expect(
        r.warnings.some((w) =>
          w.includes('self-block assertions on a parallel step'),
        ),
      ).toBe(false);
    });
  });

  describe('screenshot name uniqueness across UI sub-steps', () => {
    it('accepts unique screenshot names across multiple UI actions', () => {
      const r = makeResult();
      validateTests(
        [
          {
            name: 'unique-names',
            steps: [
              {
                action: {
                  type: 'ui',
                  target: 'a',
                  steps: [{ screenshot: 'login-page' }],
                },
              },
              {
                action: {
                  type: 'ui',
                  target: 'a',
                  steps: [{ screenshot: 'dashboard' }],
                },
              },
            ],
          },
        ],
        r,
        defFile,
        mockFs,
      );
      expect(
        r.errors.filter((e) => e.includes('duplicate screenshot name')),
      ).toHaveLength(0);
    });

    it('rejects duplicate screenshot names within the same UI action', () => {
      const r = makeResult();
      validateTests(
        [
          {
            name: 'dupe-in-action',
            steps: [
              {
                action: {
                  type: 'ui',
                  target: 'a',
                  steps: [
                    { screenshot: 'checkout' },
                    { screenshot: 'checkout' },
                  ],
                },
              },
            ],
          },
        ],
        r,
        defFile,
        mockFs,
      );
      const dupes = r.errors.filter((e) =>
        e.includes('duplicate screenshot name'),
      );
      expect(dupes).toHaveLength(1);
      expect(dupes[0]).toContain('"checkout"');
    });

    it('rejects a string-form screenshot name colliding with an object-form one', () => {
      // String form `screenshot: "x"` and object form `screenshot: { name: "x" }`
      // both write to screenshot/x.png — the uniqueness scan must catch the
      // collision regardless of which wire form each side uses.
      const r = makeResult();
      validateTests(
        [
          {
            name: 'cross-form-collision',
            steps: [
              {
                action: {
                  type: 'ui',
                  target: 'a',
                  steps: [{ screenshot: 'checkout' }],
                },
              },
              {
                action: {
                  type: 'ui',
                  target: 'b',
                  steps: [{ screenshot: { name: 'checkout', match: {} } }],
                },
              },
            ],
          },
        ],
        r,
        defFile,
        mockFs,
      );
      const dupes = r.errors.filter((e) =>
        e.includes('duplicate screenshot name'),
      );
      expect(dupes).toHaveLength(1);
      expect(dupes[0]).toContain('"checkout"');
    });

    it('rejects duplicate screenshot names across two UI actions in the same test', () => {
      const r = makeResult();
      validateTests(
        [
          {
            name: 'dupe-across-actions',
            steps: [
              {
                action: {
                  type: 'ui',
                  target: 'a',
                  steps: [{ screenshot: 'shared-name' }],
                },
              },
              {
                action: {
                  type: 'ui',
                  target: 'b',
                  steps: [{ screenshot: 'shared-name' }],
                },
              },
            ],
          },
        ],
        r,
        defFile,
        mockFs,
      );
      const dupes = r.errors.filter((e) =>
        e.includes('duplicate screenshot name'),
      );
      expect(dupes).toHaveLength(1);
      expect(dupes[0]).toContain('"shared-name"');
    });
  });
});

// ---------------------------------------------------------------------------
// validateStep
// ---------------------------------------------------------------------------

describe('validateStep', () => {
  it('errors when step is not an object', () => {
    const r = makeResult();
    validateStep(null as any, 'ctx', r);
    expect(r.errors[0]).toContain('must be an object');
  });

  it('errors when action is missing', () => {
    const r = makeResult();
    validateStep({} as any, 'ctx', r);
    expect(r.errors[0]).toContain('missing "action" object');
  });

  it('warns on unknown step keys', () => {
    const r = makeResult();
    validateStep(
      {
        action: { type: 'httpRequest', method: 'GET', url: '/api' },
        bogus: true,
      },
      'ctx',
      r,
    );
    expect(r.warnings.some((w) => w.includes('unknown property "bogus"'))).toBe(
      true,
    );
  });

  describe('httpRequest action', () => {
    it('validates a valid httpRequest', () => {
      const r = makeResult();
      validateStep(
        { action: { type: 'httpRequest', method: 'POST', url: 'svc/api' } },
        'ctx',
        r,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors on missing method', () => {
      const r = makeResult();
      validateStep({ action: { type: 'httpRequest', url: '/api' } }, 'ctx', r);
      expect(r.errors.some((e) => e.includes('requires valid "method"'))).toBe(
        true,
      );
    });

    it('errors on missing url', () => {
      const r = makeResult();
      validateStep(
        { action: { type: 'httpRequest', method: 'GET' } },
        'ctx',
        r,
      );
      expect(r.errors.some((e) => e.includes('requires "url"'))).toBe(true);
    });

    it('errors when both body and formData are present', () => {
      const r = makeResult();
      validateStep(
        {
          action: {
            type: 'httpRequest',
            method: 'POST',
            url: 'svc/upload',
            body: { key: 'value' },
            formData: { field: 'data' },
          },
        },
        'ctx',
        r,
      );
      expect(
        r.errors.some((e) =>
          e.includes('cannot have both "body" and "formData"'),
        ),
      ).toBe(true);
    });

    it('errors when formData is not an object', () => {
      const r = makeResult();
      validateStep(
        {
          action: {
            type: 'httpRequest',
            method: 'POST',
            url: 'svc/upload',
            formData: 'not-an-object',
          },
        },
        'ctx',
        r,
      );
      expect(
        r.errors.some((e) => e.includes('"formData" must be an object')),
      ).toBe(true);
    });

    it('accepts formData without body', () => {
      const r = makeResult();
      validateStep(
        {
          action: {
            type: 'httpRequest',
            method: 'POST',
            url: 'svc/upload',
            formData: { fileId: 'unique()' },
          },
        },
        'ctx',
        r,
      );
      expect(r.errors).toHaveLength(0);
    });
  });

  describe('dbQuery action', () => {
    it('validates a valid dbQuery', () => {
      const r = makeResult();
      validateStep(
        { action: { type: 'dbQuery', database: 'pg', query: 'SELECT 1' } },
        'ctx',
        r,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors on missing database', () => {
      const r = makeResult();
      validateStep(
        { action: { type: 'dbQuery', query: 'SELECT 1' } },
        'ctx',
        r,
      );
      expect(r.errors.some((e) => e.includes('requires "database"'))).toBe(
        true,
      );
    });

    it('errors on missing query', () => {
      const r = makeResult();
      validateStep({ action: { type: 'dbQuery', database: 'pg' } }, 'ctx', r);
      expect(r.errors.some((e) => e.includes('requires "query"'))).toBe(true);
    });
  });

  describe('wait action', () => {
    it('validates a valid wait', () => {
      const r = makeResult();
      validateStep({ action: { type: 'wait', durationMs: 1000 } }, 'ctx', r);
      expect(r.errors).toHaveLength(0);
    });

    it('errors on non-positive durationMs', () => {
      const r = makeResult();
      validateStep({ action: { type: 'wait', durationMs: 0 } }, 'ctx', r);
      expect(
        r.errors.some((e) => e.includes('positive integer "durationMs"')),
      ).toBe(true);
    });

    it('errors on non-integer durationMs', () => {
      const r = makeResult();
      validateStep({ action: { type: 'wait', durationMs: 1.5 } }, 'ctx', r);
      expect(
        r.errors.some((e) => e.includes('positive integer "durationMs"')),
      ).toBe(true);
    });
  });

  describe('unknown action type', () => {
    it('warns on unknown action type', () => {
      const r = makeResult();
      validateStep({ action: { type: 'unknown' } }, 'ctx', r);
      expect(r.warnings.some((w) => w.includes('unknown action type'))).toBe(
        true,
      );
    });

    it('errors on missing action type', () => {
      const r = makeResult();
      validateStep({ action: {} }, 'ctx', r);
      expect(r.errors.some((e) => e.includes('missing "type"'))).toBe(true);
    });
  });

  describe('extract', () => {
    it('accepts valid extract', () => {
      const r = makeResult();
      validateStep(
        {
          action: { type: 'wait', durationMs: 100 },
          extract: { userId: '$.response.body.id' },
        },
        'ctx',
        r,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors when extract is not an object', () => {
      const r = makeResult();
      validateStep(
        { action: { type: 'wait', durationMs: 100 }, extract: 'bad' },
        'ctx',
        r,
      );
      expect(
        r.errors.some((e) => e.includes('"extract" must be an object')),
      ).toBe(true);
    });

    it('errors when extract value is not a string', () => {
      const r = makeResult();
      validateStep(
        { action: { type: 'wait', durationMs: 100 }, extract: { key: 123 } },
        'ctx',
        r,
      );
      expect(r.errors.some((e) => e.includes('must be a string'))).toBe(true);
    });
  });

  describe('assertions', () => {
    it('errors when assertions is not an array', () => {
      const r = makeResult();
      validateStep(
        { action: { type: 'wait', durationMs: 100 }, assertions: 'bad' },
        'ctx',
        r,
      );
      expect(
        r.errors.some((e) => e.includes('"assertions" must be an array')),
      ).toBe(true);
    });

    it('validates assertion blocks within assertions array', () => {
      const r = makeResult();
      validateStep(
        {
          action: { type: 'httpRequest', method: 'GET', url: '/api' },
          assertions: [
            {
              assertions: [
                { path: '$.response.status', operator: 'eq', value: 200 },
              ],
            },
          ],
        },
        'ctx',
        r,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors on invalid assertion operator', () => {
      const r = makeResult();
      validateStep(
        {
          action: { type: 'httpRequest', method: 'GET', url: '/api' },
          assertions: [
            {
              assertions: [
                { path: '$.response.status', operator: 'bogus', value: 200 },
              ],
            },
          ],
        },
        'ctx',
        r,
      );
      expect(r.errors.some((e) => e.includes('operator must be one of'))).toBe(
        true,
      );
    });

    it('validates match block', () => {
      const r = makeResult();
      validateStep(
        {
          action: { type: 'httpRequest', method: 'GET', url: '/api' },
          assertions: [
            {
              match: {
                path: '$.traffic',
                where: [{ path: '$$.origin', operator: 'eq', value: 'svc-a' }],
              },
              assertions: [
                { path: '$.match.response.status', operator: 'eq', value: 200 },
              ],
            },
          ],
        },
        'ctx',
        r,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors when match is not an object', () => {
      const r = makeResult();
      validateStep(
        {
          action: { type: 'httpRequest', method: 'GET', url: '/api' },
          assertions: [{ match: 'bad' }],
        },
        'ctx',
        r,
      );
      expect(
        r.errors.some((e) => e.includes('"match" must be an object')),
      ).toBe(true);
    });

    it('validates extract in assertion block', () => {
      const r = makeResult();
      validateStep(
        {
          action: { type: 'httpRequest', method: 'GET', url: '/api' },
          assertions: [
            {
              extract: { id: '$.response.body.id' },
            },
          ],
        },
        'ctx',
        r,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors when assertion block extract is not an object', () => {
      const r = makeResult();
      validateStep(
        {
          action: { type: 'httpRequest', method: 'GET', url: '/api' },
          assertions: [{ extract: 'bad' }],
        },
        'ctx',
        r,
      );
      expect(
        r.errors.some((e) => e.includes('"extract" must be an object')),
      ).toBe(true);
    });

    it('errors when assertion block extract value is not a string', () => {
      const r = makeResult();
      validateStep(
        {
          action: { type: 'httpRequest', method: 'GET', url: '/api' },
          assertions: [{ extract: { key: 123 } }],
        },
        'ctx',
        r,
      );
      expect(r.errors.some((e) => e.includes('must be a string'))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// resolveVariablesRef
// ---------------------------------------------------------------------------

describe('resolveVariablesRef', () => {
  it('passes through inline-only variables without $ref', () => {
    const fs = makeMockFs({});
    const r = makeResult();
    const result = resolveVariablesRef(
      { pgConnStr: 'postgres://localhost', redis: 'redis://localhost' },
      '/defs/test.json',
      r,
      fs,
    );
    expect(r.errors).toHaveLength(0);
    expect(result).toEqual({
      pgConnStr: 'postgres://localhost',
      redis: 'redis://localhost',
    });
  });

  it('resolves a single-file $ref', () => {
    const fs = makeMockFs({
      '/shared/db-vars.json': JSON.stringify({
        pgConnStr: 'pg://host',
        redisUrl: 'redis://host',
      }),
    });
    const r = makeResult();
    const result = resolveVariablesRef(
      { $ref: '../shared/db-vars.json', extraLocal: 'value' },
      '/defs/test.json',
      r,
      fs,
    );
    expect(r.errors).toHaveLength(0);
    expect(result).toEqual({
      pgConnStr: 'pg://host',
      redisUrl: 'redis://host',
      extraLocal: 'value',
    });
  });

  it('resolves multi-file $ref with left-to-right merge', () => {
    const fs = makeMockFs({
      '/shared/db-vars.json': JSON.stringify({
        pgConnStr: 'pg://host',
        shared: 'from-db',
      }),
      '/shared/service-urls.json': JSON.stringify({
        apiUrl: 'http://api:3000',
        shared: 'from-services',
      }),
    });
    const r = makeResult();
    const result = resolveVariablesRef(
      {
        $ref: ['../shared/db-vars.json', '../shared/service-urls.json'],
        local: 'override',
      },
      '/defs/test.json',
      r,
      fs,
    );
    expect(r.errors).toHaveLength(0);
    expect(result).toEqual({
      pgConnStr: 'pg://host',
      shared: 'from-services', // last ref wins
      apiUrl: 'http://api:3000',
      local: 'override',
    });
  });

  it('inline keys override $ref keys', () => {
    const fs = makeMockFs({
      '/shared/vars.json': JSON.stringify({ key: 'from-ref', other: 'val' }),
    });
    const r = makeResult();
    const result = resolveVariablesRef(
      { $ref: '../shared/vars.json', key: 'inline-wins' },
      '/defs/test.json',
      r,
      fs,
    );
    expect(r.errors).toHaveLength(0);
    expect(result!.key).toBe('inline-wins');
    expect(result!.other).toBe('val');
  });

  it('errors when $ref file not found', () => {
    const fs = makeMockFs({});
    const r = makeResult();
    const result = resolveVariablesRef(
      { $ref: '../shared/missing.json' },
      '/defs/test.json',
      r,
      fs,
    );
    expect(result).toBeNull();
    expect(r.errors.some((e) => e.includes('not found'))).toBe(true);
  });

  it('errors when $ref file is invalid JSON', () => {
    const fs = makeMockFs({ '/shared/bad.json': '{ not valid' });
    const r = makeResult();
    const result = resolveVariablesRef(
      { $ref: '../shared/bad.json' },
      '/defs/test.json',
      r,
      fs,
    );
    expect(result).toBeNull();
    expect(r.errors.some((e) => e.includes('could not be parsed'))).toBe(true);
  });

  it('accepts $ref file with non-string values', () => {
    const fs = makeMockFs({
      '/shared/typed-vars.json': JSON.stringify({
        count: 42,
        tags: ['a', 'b'],
      }),
    });
    const r = makeResult();
    const result = resolveVariablesRef(
      { $ref: '../shared/typed-vars.json' },
      '/defs/test.json',
      r,
      fs,
    );
    expect(result).toEqual({ count: 42, tags: ['a', 'b'] });
    expect(r.errors).toHaveLength(0);
  });

  it('errors when $ref file has non-alphanumeric keys', () => {
    const fs = makeMockFs({
      '/shared/bad-keys.json': JSON.stringify({ 'bad-key': 'val' }),
    });
    const r = makeResult();
    const result = resolveVariablesRef(
      { $ref: '../shared/bad-keys.json' },
      '/defs/test.json',
      r,
      fs,
    );
    expect(result).toBeNull();
    expect(r.errors.some((e) => e.includes('must be alphanumeric'))).toBe(true);
  });

  it('errors when $ref is not a string or array', () => {
    const fs = makeMockFs({});
    const r = makeResult();
    const result = resolveVariablesRef(
      { $ref: 123 as any },
      '/defs/test.json',
      r,
      fs,
    );
    expect(result).toBeNull();
    expect(r.errors.some((e) => e.includes('must be a string or array'))).toBe(
      true,
    );
  });

  it('handles empty $ref array', () => {
    const fs = makeMockFs({});
    const r = makeResult();
    const result = resolveVariablesRef(
      { $ref: [], localOnly: 'value' },
      '/defs/test.json',
      r,
      fs,
    );
    expect(r.errors).toHaveLength(0);
    expect(result).toEqual({ localOnly: 'value' });
  });

  it('errors when $ref file is not a plain object', () => {
    const fs = makeMockFs({
      '/shared/array.json': JSON.stringify(['not', 'an', 'object']),
    });
    const r = makeResult();
    const result = resolveVariablesRef(
      { $ref: '../shared/array.json' },
      '/defs/test.json',
      r,
      fs,
    );
    expect(result).toBeNull();
    expect(r.errors.some((e) => e.includes('must be a plain object'))).toBe(
      true,
    );
  });

  describe('recursive $ref resolution', () => {
    it('resolves a variables $ref that itself has a $ref', () => {
      const fs = makeMockFs({
        '/shared/base-vars.json': JSON.stringify({
          baseUrl: 'http://localhost',
          apiKey: 'secret',
        }),
        '/shared/env-vars.json': JSON.stringify({
          $ref: './base-vars.json',
          apiKey: 'overridden',
          extra: 'val',
        }),
      });
      const r = makeResult();
      const result = resolveVariablesRef(
        { $ref: '../shared/env-vars.json' },
        '/defs/test.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
      expect(result).toEqual({
        baseUrl: 'http://localhost',
        apiKey: 'overridden',
        extra: 'val',
      });
    });

    it('detects circular variables $ref', () => {
      const fs = makeMockFs({
        '/shared/a.json': JSON.stringify({ $ref: './b.json', x: '1' }),
        '/shared/b.json': JSON.stringify({ $ref: './a.json', y: '2' }),
      });
      const r = makeResult();
      const result = resolveVariablesRef(
        { $ref: '../shared/a.json' },
        '/defs/test.json',
        r,
        fs,
      );
      expect(result).toBeNull();
      expect(r.errors.some((e) => e.includes('circular'))).toBe(true);
    });
  });
});
