import { resolveRefs, resolveActionRefs } from './validate-refs';
import { makeResult, makeMockFs } from './test-helpers';

const BASE_SERVICE = {
  type: 'SERVICE',
  name: 'my-service',
  port: 3000,
  healthCheck: '/health',
  env: [
    { name: 'DB_URL', value: 'postgres://localhost' },
    { name: 'REDIS_URL', value: 'redis://localhost' },
  ],
};

describe('resolveRefs', () => {
  describe('basic $ref resolution', () => {
    it('resolves a $ref and shallow-merges overrides', () => {
      const fs = makeMockFs({
        '/shared/service.json': JSON.stringify(BASE_SERVICE),
      });
      const r = makeResult();
      const items = [{ $ref: '../shared/service.json', port: 4000 }];

      const result = resolveRefs(items, '/defs/test.json', r, fs);

      expect(r.errors).toHaveLength(0);
      expect(result).toHaveLength(1);
      expect(result[0].item.name).toBe('my-service');
      expect(result[0].item.port).toBe(4000);
      expect(result[0].sourceFile).toBe('/shared/service.json');
    });

    it('passes through inline items unchanged', () => {
      const fs = makeMockFs({});
      const r = makeResult();
      const inlineItem = { type: 'DATABASE', name: 'pg', database: 'postgres' };

      const result = resolveRefs([inlineItem], '/defs/test.json', r, fs);

      expect(r.errors).toHaveLength(0);
      expect(result).toHaveLength(1);
      expect(result[0].item).toBe(inlineItem);
      expect(result[0].sourceFile).toBe('/defs/test.json');
    });

    it('errors when $ref file not found', () => {
      const fs = makeMockFs({});
      const r = makeResult();

      const result = resolveRefs(
        [{ $ref: '../shared/missing.json' }],
        '/defs/test.json',
        r,
        fs,
      );

      expect(result).toHaveLength(0);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toContain('not found');
    });

    it('errors when $ref file is invalid JSON', () => {
      const fs = makeMockFs({ '/shared/bad.json': '{ not valid' });
      const r = makeResult();

      const result = resolveRefs(
        [{ $ref: '../shared/bad.json' }],
        '/defs/test.json',
        r,
        fs,
      );

      expect(result).toHaveLength(0);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toContain('could not be parsed');
    });

    it('errors when item is not an object', () => {
      const fs = makeMockFs({});
      const r = makeResult();

      const result = resolveRefs(
        ['not an object' as any],
        '/defs/test.json',
        r,
        fs,
      );

      expect(result).toHaveLength(0);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toContain('must be an object');
    });
  });

  describe('array spread with ...$ref.<path>', () => {
    it('appends entries after the spread marker', () => {
      const fs = makeMockFs({
        '/shared/service.json': JSON.stringify(BASE_SERVICE),
      });
      const r = makeResult();
      const items = [
        {
          $ref: '../shared/service.json',
          env: ['...$ref.env', { name: 'EXTRA', value: 'yes' }],
        },
      ];

      const result = resolveRefs(items, '/defs/test.json', r, fs);

      expect(r.errors).toHaveLength(0);
      const env = result[0].item.env as any[];
      expect(env).toHaveLength(3);
      expect(env[0]).toEqual({ name: 'DB_URL', value: 'postgres://localhost' });
      expect(env[1]).toEqual({ name: 'REDIS_URL', value: 'redis://localhost' });
      expect(env[2]).toEqual({ name: 'EXTRA', value: 'yes' });
    });

    it('prepends entries before the spread marker', () => {
      const fs = makeMockFs({
        '/shared/service.json': JSON.stringify(BASE_SERVICE),
      });
      const r = makeResult();
      const items = [
        {
          $ref: '../shared/service.json',
          env: [{ name: 'FIRST', value: '1' }, '...$ref.env'],
        },
      ];

      const result = resolveRefs(items, '/defs/test.json', r, fs);

      expect(r.errors).toHaveLength(0);
      const env = result[0].item.env as any[];
      expect(env).toHaveLength(3);
      expect(env[0]).toEqual({ name: 'FIRST', value: '1' });
      expect(env[1]).toEqual({ name: 'DB_URL', value: 'postgres://localhost' });
      expect(env[2]).toEqual({ name: 'REDIS_URL', value: 'redis://localhost' });
    });

    it('supports entries before and after the spread marker', () => {
      const fs = makeMockFs({
        '/shared/service.json': JSON.stringify(BASE_SERVICE),
      });
      const r = makeResult();
      const items = [
        {
          $ref: '../shared/service.json',
          env: [
            { name: 'BEFORE', value: '1' },
            '...$ref.env',
            { name: 'AFTER', value: '2' },
          ],
        },
      ];

      const result = resolveRefs(items, '/defs/test.json', r, fs);

      const env = result[0].item.env as any[];
      expect(env).toHaveLength(4);
      expect(env[0]).toEqual({ name: 'BEFORE', value: '1' });
      expect(env[1]).toEqual({ name: 'DB_URL', value: 'postgres://localhost' });
      expect(env[2]).toEqual({ name: 'REDIS_URL', value: 'redis://localhost' });
      expect(env[3]).toEqual({ name: 'AFTER', value: '2' });
    });

    it('expands to nothing when path does not exist in fragment', () => {
      const fs = makeMockFs({
        '/shared/service.json': JSON.stringify(BASE_SERVICE),
      });
      const r = makeResult();
      const items = [
        {
          $ref: '../shared/service.json',
          env: ['...$ref.nonexistent', { name: 'ONLY', value: 'me' }],
        },
      ];

      const result = resolveRefs(items, '/defs/test.json', r, fs);

      expect(r.errors).toHaveLength(0);
      const env = result[0].item.env as any[];
      expect(env).toHaveLength(1);
      expect(env[0]).toEqual({ name: 'ONLY', value: 'me' });
    });

    it('expands to nothing when path resolves to a non-array', () => {
      const fs = makeMockFs({
        '/shared/service.json': JSON.stringify(BASE_SERVICE),
      });
      const r = makeResult();
      const items = [
        {
          $ref: '../shared/service.json',
          env: ['...$ref.name', { name: 'ONLY', value: 'me' }],
        },
      ];

      const result = resolveRefs(items, '/defs/test.json', r, fs);

      expect(r.errors).toHaveLength(0);
      const env = result[0].item.env as any[];
      expect(env).toHaveLength(1);
      expect(env[0]).toEqual({ name: 'ONLY', value: 'me' });
    });

    it('expands to nothing for empty path ("...$ref.")', () => {
      const fs = makeMockFs({
        '/shared/service.json': JSON.stringify(BASE_SERVICE),
      });
      const r = makeResult();
      const items = [
        {
          $ref: '../shared/service.json',
          env: ['...$ref.', { name: 'ONLY', value: 'me' }],
        },
      ];

      const result = resolveRefs(items, '/defs/test.json', r, fs);

      expect(r.errors).toHaveLength(0);
      const env = result[0].item.env as any[];
      expect(env).toHaveLength(1);
    });

    it('supports dot-path for nested fields', () => {
      const fragment = {
        type: 'SERVICE',
        name: 'svc',
        port: 3000,
        healthCheck: '/health',
        nested: {
          deep: {
            items: [
              { name: 'A', value: '1' },
              { name: 'B', value: '2' },
            ],
          },
        },
      };
      const fs = makeMockFs({
        '/shared/service.json': JSON.stringify(fragment),
      });
      const r = makeResult();
      const items = [
        {
          $ref: '../shared/service.json',
          env: ['...$ref.nested.deep.items', { name: 'C', value: '3' }],
        },
      ];

      const result = resolveRefs(items, '/defs/test.json', r, fs);

      const env = result[0].item.env as any[];
      expect(env).toHaveLength(3);
      expect(env[0]).toEqual({ name: 'A', value: '1' });
      expect(env[1]).toEqual({ name: 'B', value: '2' });
      expect(env[2]).toEqual({ name: 'C', value: '3' });
    });

    it('handles multiple spread markers in one array', () => {
      const fragment = {
        type: 'SERVICE',
        name: 'svc',
        port: 3000,
        healthCheck: '/health',
        env: [{ name: 'A', value: '1' }],
        extraEnv: [{ name: 'B', value: '2' }],
      };
      const fs = makeMockFs({
        '/shared/service.json': JSON.stringify(fragment),
      });
      const r = makeResult();
      const items = [
        {
          $ref: '../shared/service.json',
          env: ['...$ref.env', '...$ref.extraEnv', { name: 'C', value: '3' }],
        },
      ];

      const result = resolveRefs(items, '/defs/test.json', r, fs);

      const env = result[0].item.env as any[];
      expect(env).toHaveLength(3);
      expect(env[0]).toEqual({ name: 'A', value: '1' });
      expect(env[1]).toEqual({ name: 'B', value: '2' });
      expect(env[2]).toEqual({ name: 'C', value: '3' });
    });

    it('replaces entire array when no spread marker is used (existing behavior)', () => {
      const fs = makeMockFs({
        '/shared/service.json': JSON.stringify(BASE_SERVICE),
      });
      const r = makeResult();
      const items = [
        {
          $ref: '../shared/service.json',
          env: [{ name: 'ONLY', value: 'this' }],
        },
      ];

      const result = resolveRefs(items, '/defs/test.json', r, fs);

      expect(r.errors).toHaveLength(0);
      const env = result[0].item.env as any[];
      expect(env).toHaveLength(1);
      expect(env[0]).toEqual({ name: 'ONLY', value: 'this' });
    });

    it('does not attempt expansion on non-$ref items', () => {
      const fs = makeMockFs({});
      const r = makeResult();
      const inlineItem = {
        type: 'SERVICE',
        name: 'svc',
        port: 3000,
        healthCheck: '/health',
        env: ['...$ref.env', { name: 'X', value: 'Y' }],
      };

      const result = resolveRefs([inlineItem], '/defs/test.json', r, fs);

      // Inline items are passed through as-is, no expansion
      const env = result[0].item.env as any[];
      expect(env).toHaveLength(2);
      expect(env[0]).toBe('...$ref.env');
    });
  });

  describe('multi-ref $ref resolution (items)', () => {
    it('resolves multiple $ref files and merges left-to-right', () => {
      const base = {
        type: 'SERVICE',
        name: 'api-gateway',
        image: 'api-gateway:latest',
        port: 3000,
        healthCheck: '/health',
      };
      const overlay = {
        image: 'api-gateway:staging',
        port: 4000,
      };
      const fs = makeMockFs({
        '/shared/base.json': JSON.stringify(base),
        '/shared/overlay.json': JSON.stringify(overlay),
      });
      const r = makeResult();
      const items = [
        { $ref: ['../shared/base.json', '../shared/overlay.json'] },
      ];

      const result = resolveRefs(items, '/defs/test.json', r, fs);

      expect(r.errors).toHaveLength(0);
      expect(result).toHaveLength(1);
      expect(result[0].item.name).toBe('api-gateway');
      expect(result[0].item.image).toBe('api-gateway:staging'); // overlay wins
      expect(result[0].item.port).toBe(4000); // overlay wins
      expect(result[0].item.healthCheck).toBe('/health'); // base preserved
    });

    it('inline keys override multi-ref', () => {
      const fs = makeMockFs({
        '/shared/base.json': JSON.stringify({
          type: 'SERVICE',
          name: 'svc',
          port: 3000,
          healthCheck: '/h',
        }),
        '/shared/overlay.json': JSON.stringify({ port: 4000 }),
      });
      const r = makeResult();
      const items = [
        { $ref: ['../shared/base.json', '../shared/overlay.json'], port: 9090 },
      ];

      const result = resolveRefs(items, '/defs/test.json', r, fs);

      expect(r.errors).toHaveLength(0);
      expect(result[0].item.port).toBe(9090); // inline wins over both refs
    });

    it('sourceFile points to the last ref file', () => {
      const fs = makeMockFs({
        '/shared/base.json': JSON.stringify({
          type: 'SERVICE',
          name: 'svc',
          port: 3000,
          healthCheck: '/h',
        }),
        '/shared/overlay.json': JSON.stringify({ port: 4000 }),
      });
      const r = makeResult();
      const items = [
        { $ref: ['../shared/base.json', '../shared/overlay.json'] },
      ];

      const result = resolveRefs(items, '/defs/test.json', r, fs);

      expect(result[0].sourceFile).toBe('/shared/overlay.json');
    });

    it('errors when any multi-ref file is missing', () => {
      const fs = makeMockFs({
        '/shared/base.json': JSON.stringify({
          type: 'SERVICE',
          name: 'svc',
          port: 3000,
          healthCheck: '/h',
        }),
      });
      const r = makeResult();
      const items = [
        { $ref: ['../shared/base.json', '../shared/missing.json'] },
      ];

      const result = resolveRefs(items, '/defs/test.json', r, fs);

      expect(result).toHaveLength(0);
      expect(r.errors.some((e) => e.includes('not found'))).toBe(true);
    });

    it('spread markers expand against merged multi-ref content', () => {
      const base = {
        type: 'SERVICE',
        name: 'svc',
        port: 3000,
        healthCheck: '/h',
        env: [{ name: 'BASE', value: '1' }],
      };
      const overlay = {
        env: [{ name: 'OVERLAY', value: '2' }],
      };
      const fs = makeMockFs({
        '/shared/base.json': JSON.stringify(base),
        '/shared/overlay.json': JSON.stringify(overlay),
      });
      const r = makeResult();
      const items = [
        {
          $ref: ['../shared/base.json', '../shared/overlay.json'],
          env: ['...$ref.env', { name: 'INLINE', value: '3' }],
        },
      ];

      const result = resolveRefs(items, '/defs/test.json', r, fs);

      expect(r.errors).toHaveLength(0);
      // overlay.env overwrites base.env (shallow merge), so spread expands overlay.env
      const env = result[0].item.env as any[];
      expect(env).toHaveLength(2);
      expect(env[0]).toEqual({ name: 'OVERLAY', value: '2' });
      expect(env[1]).toEqual({ name: 'INLINE', value: '3' });
    });

    it('single-string $ref continues to work', () => {
      const fs = makeMockFs({
        '/shared/service.json': JSON.stringify(BASE_SERVICE),
      });
      const r = makeResult();
      const items = [{ $ref: '../shared/service.json', port: 4000 }];

      const result = resolveRefs(items, '/defs/test.json', r, fs);

      expect(r.errors).toHaveLength(0);
      expect(result[0].item.port).toBe(4000);
      expect(result[0].item.name).toBe('my-service');
    });
  });
});

// ---------------------------------------------------------------------------
// resolveActionRefs
// ---------------------------------------------------------------------------

function makeUiDefinition(actionSteps: unknown[]): Record<string, unknown> {
  return {
    name: 'test-def',
    items: [],
    tests: [
      {
        name: 'test 1',
        steps: [
          {
            name: 'do ui stuff',
            action: { type: 'ui', target: 'my-app', steps: actionSteps },
          },
        ],
      },
    ],
  };
}

const LOGIN_FRAGMENT = JSON.stringify({
  name: 'Login flow',
  description: 'Signs in via Google OAuth mock',
  steps: [
    { visit: '/login' },
    { click: '[data-testid="login-btn"]' },
    { waitFor: '[data-testid="dashboard"]' },
  ],
});

describe('resolveActionRefs', () => {
  it('splices referenced steps into the array', () => {
    const fs = makeMockFs({
      '/shared/login.json': LOGIN_FRAGMENT,
    });
    const r = makeResult();
    const def = makeUiDefinition([
      { $ref: '../shared/login.json' },
      { click: '[data-testid="nav"]' },
    ]);

    resolveActionRefs(def, '/defs/test.json', r, fs);

    expect(r.errors).toHaveLength(0);
    const steps = (
      (def.tests as any[])[0].steps[0].action as Record<string, unknown>
    ).steps as unknown[];
    expect(steps).toHaveLength(4);
    expect(steps[0]).toEqual({ visit: '/login' });
    expect(steps[1]).toEqual({ click: '[data-testid="login-btn"]' });
    expect(steps[2]).toEqual({ waitFor: '[data-testid="dashboard"]' });
    expect(steps[3]).toEqual({ click: '[data-testid="nav"]' });
  });

  it('handles multiple $ref entries in one steps array', () => {
    const fs = makeMockFs({
      '/shared/login.json': LOGIN_FRAGMENT,
      '/shared/logout.json': JSON.stringify({
        steps: [{ click: '[data-testid="logout"]' }],
      }),
    });
    const r = makeResult();
    const def = makeUiDefinition([
      { $ref: '../shared/login.json' },
      { screenshot: 'after-login' },
      { $ref: '../shared/logout.json' },
    ]);

    resolveActionRefs(def, '/defs/test.json', r, fs);

    expect(r.errors).toHaveLength(0);
    const steps = (
      (def.tests as any[])[0].steps[0].action as Record<string, unknown>
    ).steps as unknown[];
    expect(steps).toHaveLength(5);
    expect(steps[3]).toEqual({ screenshot: 'after-login' });
    expect(steps[4]).toEqual({ click: '[data-testid="logout"]' });
  });

  it('errors when $ref file not found', () => {
    const fs = makeMockFs({});
    const r = makeResult();
    const def = makeUiDefinition([{ $ref: '../shared/missing.json' }]);

    resolveActionRefs(def, '/defs/test.json', r, fs);

    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('not found');
  });

  it('errors when $ref file cannot be parsed', () => {
    const fs = makeMockFs({ '/shared/bad.json': '{ not valid' });
    const r = makeResult();
    const def = makeUiDefinition([{ $ref: '../shared/bad.json' }]);

    resolveActionRefs(def, '/defs/test.json', r, fs);

    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('could not be parsed');
  });

  it('errors when fragment is missing the steps key', () => {
    const fs = makeMockFs({
      '/shared/no-steps.json': JSON.stringify({ visit: '/login' }),
    });
    const r = makeResult();
    const def = makeUiDefinition([{ $ref: '../shared/no-steps.json' }]);

    resolveActionRefs(def, '/defs/test.json', r, fs);

    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('must contain a "steps" array');
  });

  it('errors when fragment steps is not an array', () => {
    const fs = makeMockFs({
      '/shared/bad-steps.json': JSON.stringify({ steps: 'not-array' }),
    });
    const r = makeResult();
    const def = makeUiDefinition([{ $ref: '../shared/bad-steps.json' }]);

    resolveActionRefs(def, '/defs/test.json', r, fs);

    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('must contain a "steps" array');
  });

  it('errors when $ref value is not a string', () => {
    const fs = makeMockFs({});
    const r = makeResult();
    const def = makeUiDefinition([{ $ref: 42 }]);

    resolveActionRefs(def, '/defs/test.json', r, fs);

    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('must be a string path');
  });

  it('allows name and description in fragment without warning', () => {
    const fs = makeMockFs({
      '/shared/named.json': JSON.stringify({
        name: 'Login flow',
        description: 'Signs in via OAuth',
        steps: [{ visit: '/home' }],
      }),
    });
    const r = makeResult();
    const def = makeUiDefinition([{ $ref: '../shared/named.json' }]);

    resolveActionRefs(def, '/defs/test.json', r, fs);

    expect(r.errors).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
  });

  it('warns on unrecognized keys in fragment file', () => {
    const fs = makeMockFs({
      '/shared/extra.json': JSON.stringify({
        steps: [{ visit: '/home' }],
        somethingElse: true,
      }),
    });
    const r = makeResult();
    const def = makeUiDefinition([{ $ref: '../shared/extra.json' }]);

    resolveActionRefs(def, '/defs/test.json', r, fs);

    expect(r.errors).toHaveLength(0);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('extra keys');
  });

  it('handles empty steps array in fragment', () => {
    const fs = makeMockFs({
      '/shared/empty.json': JSON.stringify({ steps: [] }),
    });
    const r = makeResult();
    const def = makeUiDefinition([
      { $ref: '../shared/empty.json' },
      { click: 'button' },
    ]);

    resolveActionRefs(def, '/defs/test.json', r, fs);

    expect(r.errors).toHaveLength(0);
    const steps = (
      (def.tests as any[])[0].steps[0].action as Record<string, unknown>
    ).steps as unknown[];
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({ click: 'button' });
  });

  it('is a no-op when definition has no tests', () => {
    const fs = makeMockFs({});
    const r = makeResult();
    const def = { name: 'no-tests', items: [] };

    resolveActionRefs(def, '/defs/test.json', r, fs);

    expect(r.errors).toHaveLength(0);
  });

  it('does not touch non-ui actions without $ref', () => {
    const fs = makeMockFs({});
    const r = makeResult();
    const def = {
      name: 'http-test',
      items: [],
      tests: [
        {
          name: 'http step',
          steps: [
            [
              {
                name: 'call api',
                action: {
                  type: 'httpRequest',
                  method: 'GET',
                  url: 'my-svc/api',
                },
              },
            ],
          ],
        },
      ],
    };

    resolveActionRefs(def, '/defs/test.json', r, fs);

    expect(r.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resolveActionRefs — action-level $ref (httpRequest, dbQuery, ui, wait)
// ---------------------------------------------------------------------------

function makeStepDefinition(
  action: Record<string, unknown>,
): Record<string, unknown> {
  return {
    name: 'test-def',
    items: [],
    tests: [
      {
        name: 'test 1',
        steps: [{ name: 'step 1', action }],
      },
    ],
  };
}

const HTTP_ACTION_FRAGMENT = JSON.stringify({
  name: 'Create user',
  description: 'POST to create a new user',
  action: {
    type: 'httpRequest',
    method: 'POST',
    url: 'api-gateway/api/users',
    headers: { 'Content-Type': 'application/json' },
    body: { name: 'default-user' },
  },
});

const DB_ACTION_FRAGMENT = JSON.stringify({
  name: 'Count users',
  description: 'Gets total user count',
  action: {
    type: 'dbQuery',
    database: 'postgres-db',
    query: 'SELECT count(*) FROM users',
  },
});

const UI_ACTION_FRAGMENT = JSON.stringify({
  name: 'Full login action',
  action: {
    type: 'ui',
    target: 'my-app',
    steps: [
      { visit: '/login' },
      { click: '[data-testid="login-btn"]' },
      { waitFor: '[data-testid="dashboard"]' },
    ],
  },
});

describe('resolveActionRefs — action-level $ref', () => {
  it('resolves httpRequest action from fragment', () => {
    const fs = makeMockFs({
      '/shared/create-user.json': HTTP_ACTION_FRAGMENT,
    });
    const r = makeResult();
    const def = makeStepDefinition({
      $ref: '../shared/create-user.json',
    });

    resolveActionRefs(def, '/defs/test.json', r, fs);

    expect(r.errors).toHaveLength(0);
    const action = (def.tests as any[])[0].steps[0].action;
    expect(action.type).toBe('httpRequest');
    expect(action.method).toBe('POST');
    expect(action.url).toBe('api-gateway/api/users');
    expect(action.body).toEqual({ name: 'default-user' });
    expect(action.$ref).toBeUndefined();
  });

  it('shallow-merges inline overrides onto fragment action', () => {
    const fs = makeMockFs({
      '/shared/create-user.json': HTTP_ACTION_FRAGMENT,
    });
    const r = makeResult();
    const def = makeStepDefinition({
      $ref: '../shared/create-user.json',
      body: { name: 'custom-name', email: 'a@b.com' },
    });

    resolveActionRefs(def, '/defs/test.json', r, fs);

    expect(r.errors).toHaveLength(0);
    const action = (def.tests as any[])[0].steps[0].action;
    expect(action.method).toBe('POST');
    expect(action.body).toEqual({ name: 'custom-name', email: 'a@b.com' });
  });

  it('resolves dbQuery action from fragment', () => {
    const fs = makeMockFs({
      '/shared/count-users.json': DB_ACTION_FRAGMENT,
    });
    const r = makeResult();
    const def = makeStepDefinition({
      $ref: '../shared/count-users.json',
    });

    resolveActionRefs(def, '/defs/test.json', r, fs);

    expect(r.errors).toHaveLength(0);
    const action = (def.tests as any[])[0].steps[0].action;
    expect(action.type).toBe('dbQuery');
    expect(action.database).toBe('postgres-db');
    expect(action.query).toBe('SELECT count(*) FROM users');
  });

  it('resolves ui action from fragment', () => {
    const fs = makeMockFs({
      '/shared/login-action.json': UI_ACTION_FRAGMENT,
    });
    const r = makeResult();
    const def = makeStepDefinition({
      $ref: '../shared/login-action.json',
    });

    resolveActionRefs(def, '/defs/test.json', r, fs);

    expect(r.errors).toHaveLength(0);
    const action = (def.tests as any[])[0].steps[0].action;
    expect(action.type).toBe('ui');
    expect(action.target).toBe('my-app');
    expect(action.steps).toHaveLength(3);
  });

  it('errors when action fragment file not found', () => {
    const fs = makeMockFs({});
    const r = makeResult();
    const def = makeStepDefinition({ $ref: '../shared/missing.json' });

    resolveActionRefs(def, '/defs/test.json', r, fs);

    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('not found');
  });

  it('errors when action fragment cannot be parsed', () => {
    const fs = makeMockFs({ '/shared/bad.json': '{ nope' });
    const r = makeResult();
    const def = makeStepDefinition({ $ref: '../shared/bad.json' });

    resolveActionRefs(def, '/defs/test.json', r, fs);

    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('could not be parsed');
  });

  it('errors when fragment is missing the action key', () => {
    const fs = makeMockFs({
      '/shared/no-action.json': JSON.stringify({
        name: 'Bad fragment',
        type: 'httpRequest',
      }),
    });
    const r = makeResult();
    const def = makeStepDefinition({ $ref: '../shared/no-action.json' });

    resolveActionRefs(def, '/defs/test.json', r, fs);

    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('must contain an "action" object');
  });

  it('allows name and description without warning', () => {
    const fs = makeMockFs({
      '/shared/create-user.json': HTTP_ACTION_FRAGMENT,
    });
    const r = makeResult();
    const def = makeStepDefinition({ $ref: '../shared/create-user.json' });

    resolveActionRefs(def, '/defs/test.json', r, fs);

    expect(r.errors).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
  });

  it('warns on unrecognized keys in action fragment', () => {
    const fs = makeMockFs({
      '/shared/extra.json': JSON.stringify({
        action: { type: 'httpRequest', method: 'GET', url: 'svc/api' },
        foo: 'bar',
      }),
    });
    const r = makeResult();
    const def = makeStepDefinition({ $ref: '../shared/extra.json' });

    resolveActionRefs(def, '/defs/test.json', r, fs);

    expect(r.errors).toHaveLength(0);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('extra keys');
    expect(r.warnings[0]).toContain('foo');
  });

  it('overrides can change the database target', () => {
    const fs = makeMockFs({
      '/shared/count-users.json': DB_ACTION_FRAGMENT,
    });
    const r = makeResult();
    const def = makeStepDefinition({
      $ref: '../shared/count-users.json',
      database: 'mysql-db',
      query: 'SELECT count(*) FROM accounts',
    });

    resolveActionRefs(def, '/defs/test.json', r, fs);

    expect(r.errors).toHaveLength(0);
    const action = (def.tests as any[])[0].steps[0].action;
    expect(action.database).toBe('mysql-db');
    expect(action.query).toBe('SELECT count(*) FROM accounts');
    expect(action.type).toBe('dbQuery');
  });
});

// ---------------------------------------------------------------------------
// Recursive $ref resolution
// ---------------------------------------------------------------------------

describe('recursive $ref resolution', () => {
  describe('resolveRefs — item-level recursion', () => {
    it('resolves a $ref that itself has a $ref (two levels)', () => {
      const base = {
        type: 'SERVICE',
        name: 'base-service',
        port: 3000,
        healthCheck: '/health',
      };
      const middle = {
        $ref: './base.json',
        port: 4000,
      };
      const fs = makeMockFs({
        '/shared/base.json': JSON.stringify(base),
        '/shared/middle.json': JSON.stringify(middle),
      });
      const r = makeResult();
      const items = [{ $ref: '../shared/middle.json', port: 5000 }];

      const result = resolveRefs(items, '/defs/test.json', r, fs);

      expect(r.errors).toHaveLength(0);
      expect(result).toHaveLength(1);
      expect(result[0].item.name).toBe('base-service');
      expect(result[0].item.port).toBe(5000); // outermost override wins
      expect(result[0].item.healthCheck).toBe('/health');
    });

    it('resolves three levels of $ref', () => {
      const fs = makeMockFs({
        '/shared/l1.json': JSON.stringify({
          type: 'SERVICE',
          name: 'l1',
          port: 1000,
          healthCheck: '/health',
        }),
        '/shared/l2.json': JSON.stringify({
          $ref: './l1.json',
          name: 'l2',
          port: 2000,
        }),
        '/shared/l3.json': JSON.stringify({
          $ref: './l2.json',
          name: 'l3',
        }),
      });
      const r = makeResult();
      const items = [{ $ref: '../shared/l3.json' }];

      const result = resolveRefs(items, '/defs/test.json', r, fs);

      expect(r.errors).toHaveLength(0);
      expect(result[0].item.name).toBe('l3');
      expect(result[0].item.port).toBe(2000);
      expect(result[0].item.type).toBe('SERVICE');
    });

    it('detects circular $ref in items', () => {
      const fs = makeMockFs({
        '/shared/a.json': JSON.stringify({ $ref: './b.json', name: 'a' }),
        '/shared/b.json': JSON.stringify({ $ref: './a.json', name: 'b' }),
      });
      const r = makeResult();
      const items = [{ $ref: '../shared/a.json' }];

      resolveRefs(items, '/defs/test.json', r, fs);

      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors.some((e) => e.includes('circular'))).toBe(true);
    });

    it('resolves multi-ref where one element has a recursive $ref', () => {
      const fs = makeMockFs({
        '/shared/base.json': JSON.stringify({
          type: 'SERVICE',
          name: 'base',
          port: 3000,
          healthCheck: '/health',
        }),
        '/shared/with-ref.json': JSON.stringify({
          $ref: './base.json',
          port: 4000,
        }),
        '/shared/extra.json': JSON.stringify({
          env: [{ name: 'NODE_ENV', value: 'test' }],
        }),
      });
      const r = makeResult();
      const items = [
        {
          $ref: ['../shared/with-ref.json', '../shared/extra.json'],
          name: 'final',
        },
      ];

      const result = resolveRefs(items, '/defs/test.json', r, fs);

      expect(r.errors).toHaveLength(0);
      expect(result).toHaveLength(1);
      expect(result[0].item.type).toBe('SERVICE');
      expect(result[0].item.port).toBe(4000);
      expect(result[0].item.healthCheck).toBe('/health');
      expect(result[0].item.env).toEqual([{ name: 'NODE_ENV', value: 'test' }]);
      expect(result[0].item.name).toBe('final');
    });

    it('errors when $ref chain exceeds max depth', () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 12; i++) {
        const content =
          i === 0
            ? {
                type: 'SERVICE',
                name: 'deep',
                port: 3000,
                healthCheck: '/health',
              }
            : { $ref: `./l${i - 1}.json` };
        files[`/shared/l${i}.json`] = JSON.stringify(content);
      }
      const fs = makeMockFs(files);
      const r = makeResult();
      const items = [{ $ref: '../shared/l11.json' }];

      resolveRefs(items, '/defs/test.json', r, fs);

      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors.some((e) => e.includes('maximum depth'))).toBe(true);
    });

    it('detects self-referencing $ref', () => {
      const fs = makeMockFs({
        '/shared/self.json': JSON.stringify({ $ref: './self.json', name: 'x' }),
      });
      const r = makeResult();
      const items = [{ $ref: '../shared/self.json' }];

      resolveRefs(items, '/defs/test.json', r, fs);

      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors.some((e) => e.includes('circular'))).toBe(true);
    });
  });

  describe('resolveActionRefs — action-level recursion', () => {
    it('resolves action $ref that itself has $ref', () => {
      const fs = makeMockFs({
        '/shared/base-action.json': JSON.stringify({
          action: {
            type: 'httpRequest',
            method: 'POST',
            url: 'api/users',
          },
        }),
        '/shared/create-user.json': JSON.stringify({
          action: {
            $ref: './base-action.json',
            body: { name: 'default' },
          },
        }),
      });
      const r = makeResult();
      const def = makeStepDefinition({
        $ref: '../shared/create-user.json',
        body: { name: 'custom' },
      });

      resolveActionRefs(def, '/defs/test.json', r, fs);

      expect(r.errors).toHaveLength(0);
      const action = (def.tests as any[])[0].steps[0].action;
      expect(action.type).toBe('httpRequest');
      expect(action.method).toBe('POST');
      expect(action.url).toBe('api/users');
      expect(action.body).toEqual({ name: 'custom' });
    });

    it('detects circular action $ref', () => {
      const fs = makeMockFs({
        '/shared/a.json': JSON.stringify({
          action: { $ref: './b.json' },
        }),
        '/shared/b.json': JSON.stringify({
          action: { $ref: './a.json' },
        }),
      });
      const r = makeResult();
      const def = makeStepDefinition({ $ref: '../shared/a.json' });

      resolveActionRefs(def, '/defs/test.json', r, fs);

      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors.some((e) => e.includes('circular'))).toBe(true);
    });
  });

  describe('resolveActionRefs — sub-step recursion', () => {
    it('resolves sub-step $ref that itself contains $ref entries', () => {
      const fs = makeMockFs({
        '/shared/inner.json': JSON.stringify({
          steps: [{ click: '[data-testid="inner"]' }],
        }),
        '/shared/outer.json': JSON.stringify({
          steps: [{ visit: '/page' }, { $ref: './inner.json' }],
        }),
      });
      const r = makeResult();
      const def = makeUiDefinition([
        { $ref: '../shared/outer.json' },
        { screenshot: 'done' },
      ]);

      resolveActionRefs(def, '/defs/test.json', r, fs);

      expect(r.errors).toHaveLength(0);
      const steps = (
        (def.tests as any[])[0].steps[0].action as Record<string, unknown>
      ).steps as unknown[];
      expect(steps).toHaveLength(3);
      expect(steps[0]).toEqual({ visit: '/page' });
      expect(steps[1]).toEqual({ click: '[data-testid="inner"]' });
      expect(steps[2]).toEqual({ screenshot: 'done' });
    });

    it('detects circular sub-step $ref', () => {
      const fs = makeMockFs({
        '/shared/a.json': JSON.stringify({
          steps: [{ $ref: './b.json' }],
        }),
        '/shared/b.json': JSON.stringify({
          steps: [{ $ref: './a.json' }],
        }),
      });
      const r = makeResult();
      const def = makeUiDefinition([{ $ref: '../shared/a.json' }]);

      resolveActionRefs(def, '/defs/test.json', r, fs);

      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors.some((e) => e.includes('circular'))).toBe(true);
    });
  });
});
