import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveDefinitions, MAX_FILE_BYTES } from './resolve';

function createTempDokkimi(): string {
  const tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'dokkimi-test-')),
  );
  const dokkimiDir = path.join(tmp, '.dokkimi');
  fs.mkdirSync(dokkimiDir, { recursive: true });
  return dokkimiDir;
}

function writeFile(dir: string, relPath: string, content: unknown): string {
  const absPath = path.resolve(dir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const str =
    typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  fs.writeFileSync(absPath, str);
  return absPath;
}

function minimalDef(
  name: string,
  items: Record<string, unknown>[] = [],
  extra: Record<string, unknown> = {},
) {
  const defaultItem = {
    type: 'SERVICE',
    name: 'svc',
    port: 3000,
    healthCheck: '/health',
  };
  const finalItems = items.length > 0 ? items : [defaultItem];
  const tests = [
    { name: 't', steps: [{ action: { type: 'wait', durationMs: 1 } }] },
  ];
  return { name, items: finalItems, tests, ...extra };
}

afterAll(() => {
  // tmpdir is cleaned up by OS
});

describe('consumedFiles tracking', () => {
  let origCwd: string;
  let dokkimiDir: string;

  beforeEach(() => {
    origCwd = process.cwd();
    dokkimiDir = createTempDokkimi();
  });

  afterEach(() => {
    process.chdir(origCwd);
  });

  it('includes the definition file itself', () => {
    const defPath = writeFile(dokkimiDir, 'test.json', minimalDef('basic'));
    const result = resolveDefinitions(defPath);

    expect(result.consumedFiles).toContain(path.resolve(defPath));
    expect(result.definitions).toHaveLength(1);
  });

  it('includes $ref target files', () => {
    const sharedPath = writeFile(dokkimiDir, 'shared/svc.json', {
      type: 'SERVICE',
      name: 'my-svc',
      port: 3000,
      healthCheck: '/health',
    });
    const defPath = writeFile(
      dokkimiDir,
      'test.json',
      minimalDef('with-ref', [{ $ref: './shared/svc.json' }]),
    );

    const result = resolveDefinitions(defPath);

    expect(result.consumedFiles).toContain(path.resolve(defPath));
    expect(result.consumedFiles).toContain(path.resolve(sharedPath));
  });

  it('includes chained $ref files', () => {
    const basePath = writeFile(dokkimiDir, 'shared/base.json', {
      type: 'SERVICE',
      name: 'base-svc',
      port: 3000,
      healthCheck: '/health',
    });
    const midPath = writeFile(dokkimiDir, 'shared/mid.json', {
      $ref: './base.json',
      port: 4000,
    });
    const defPath = writeFile(
      dokkimiDir,
      'test.json',
      minimalDef('chained', [{ $ref: './shared/mid.json' }]),
    );

    const result = resolveDefinitions(defPath);

    expect(result.consumedFiles).toContain(path.resolve(defPath));
    expect(result.consumedFiles).toContain(path.resolve(midPath));
    expect(result.consumedFiles).toContain(path.resolve(basePath));
  });

  it('includes init files for DATABASE items', () => {
    const initPath = writeFile(
      dokkimiDir,
      'init.sql',
      'CREATE TABLE t (id INT);',
    );
    const defPath = writeFile(
      dokkimiDir,
      'test.json',
      minimalDef('with-init', [
        {
          type: 'DATABASE',
          name: 'pg',
          database: 'postgres',
          initFilePath: './init.sql',
        },
      ]),
    );

    const result = resolveDefinitions(defPath);

    expect(result.consumedFiles).toContain(path.resolve(initPath));
  });

  it('includes the config file when present', () => {
    const configPath = writeFile(dokkimiDir, 'config.yaml', 'env:\n  FOO: bar');
    const defPath = writeFile(dokkimiDir, 'test.json', minimalDef('with-cfg'));

    const result = resolveDefinitions(defPath);

    expect(result.consumedFiles).toContain(path.resolve(configPath));
  });

  it('includes variables $ref files', () => {
    const varsPath = writeFile(dokkimiDir, 'shared/vars.json', {
      baseUrl: 'http://localhost:3000',
    });
    const defPath = writeFile(
      dokkimiDir,
      'test.json',
      minimalDef('with-vars', [], {
        variables: { $ref: './shared/vars.json' },
      }),
    );

    const result = resolveDefinitions(defPath);

    expect(result.consumedFiles).toContain(path.resolve(varsPath));
  });

  it('does not include files from other definitions in the directory', () => {
    writeFile(dokkimiDir, 'other.json', minimalDef('other-def'));
    const defPath = writeFile(dokkimiDir, 'target.json', minimalDef('target'));

    const result = resolveDefinitions(defPath);

    expect(result.consumedFiles).toHaveLength(1);
    expect(result.consumedFiles).toContain(path.resolve(defPath));
  });

  it('includes all files when resolving a directory', () => {
    const def1 = writeFile(dokkimiDir, 'a.json', minimalDef('def-a'));
    const def2 = writeFile(dokkimiDir, 'b.json', minimalDef('def-b'));

    process.chdir(path.dirname(dokkimiDir));
    const result = resolveDefinitions();

    expect(result.consumedFiles).toContain(path.resolve(def1));
    expect(result.consumedFiles).toContain(path.resolve(def2));
  });

  it('includes definition files even when they have validation errors', () => {
    const defPath = writeFile(dokkimiDir, 'bad.json', {
      name: 'bad',
      items: [{ type: 'INVALID_TYPE', name: 'x' }],
    });

    const result = resolveDefinitions(defPath);

    expect(result.consumedFiles).toContain(path.resolve(defPath));
  });

  it('returns empty consumedFiles when no definitions found', () => {
    process.chdir(path.dirname(dokkimiDir));
    const result = resolveDefinitions();

    expect(result.consumedFiles).toEqual([]);
  });
});

describe('build-time variable interpolation in items', () => {
  let origCwd: string;
  let dokkimiDir: string;

  beforeEach(() => {
    origCwd = process.cwd();
    dokkimiDir = createTempDokkimi();
  });

  afterEach(() => {
    process.chdir(origCwd);
  });

  it('resolves {{VAR}} in item env values from definition variables', () => {
    const defPath = writeFile(
      dokkimiDir,
      'test.json',
      minimalDef(
        'var-test',
        [
          {
            type: 'SERVICE',
            name: 'svc',
            port: 3000,
            healthCheck: '/health',
            env: [{ name: 'DB_PASS', value: '{{PASSWORD}}' }],
          },
        ],
        { variables: { PASSWORD: 'secret123' } },
      ),
    );

    const result = resolveDefinitions(defPath);

    const actualErrors = result.errors.filter((e) => e.errors.length > 0);
    expect(actualErrors).toEqual([]);
    expect(result.definitions).toHaveLength(1);
    const item = (result.definitions[0].definition.items as any[])[0];
    expect(item.env[0].value).toBe('secret123');
  });

  it('resolves {{VAR}} in $ref fragments from definition variables', () => {
    writeFile(dokkimiDir, 'shared/db.json', {
      type: 'DATABASE',
      name: 'my-db',
      database: 'postgres',
      dbPassword: '{{DB_PASSWORD}}',
    });
    const defPath = writeFile(
      dokkimiDir,
      'test.json',
      minimalDef('ref-var-test', [{ $ref: './shared/db.json' }], {
        variables: { DB_PASSWORD: 'changeme' },
      }),
    );

    const result = resolveDefinitions(defPath);

    expect(result.errors.filter((e) => e.errors.length > 0)).toEqual([]);
    const item = (result.definitions[0].definition.items as any[])[0];
    expect(item.dbPassword).toBe('changeme');
  });

  it('uses config.yaml env as baseline for variables', () => {
    writeFile(dokkimiDir, 'config.yaml', 'env:\n  REGISTRY: ghcr.io/myorg');
    const defPath = writeFile(
      dokkimiDir,
      'test.json',
      minimalDef('config-baseline', [
        {
          type: 'SERVICE',
          name: 'svc',
          image: '{{REGISTRY}}/my-service:latest',
          port: 3000,
          healthCheck: '/health',
        },
      ]),
    );

    const result = resolveDefinitions(defPath);

    expect(result.errors.filter((e) => e.errors.length > 0)).toEqual([]);
    const item = (result.definitions[0].definition.items as any[])[0];
    expect(item.image).toBe('ghcr.io/myorg/my-service:latest');
  });

  it('definition variables override config.yaml env', () => {
    writeFile(dokkimiDir, 'config.yaml', 'env:\n  PORT: "3000"');
    const defPath = writeFile(
      dokkimiDir,
      'test.json',
      minimalDef(
        'override-test',
        [
          {
            type: 'SERVICE',
            name: 'svc',
            port: 3000,
            healthCheck: '/health',
            env: [{ name: 'APP_PORT', value: '{{PORT}}' }],
          },
        ],
        { variables: { PORT: '8080' } },
      ),
    );

    const result = resolveDefinitions(defPath);

    expect(result.errors.filter((e) => e.errors.length > 0)).toEqual([]);
    const item = (result.definitions[0].definition.items as any[])[0];
    expect(item.env[0].value).toBe('8080');
  });

  it('errors on unresolved {{VAR}} in items', () => {
    const defPath = writeFile(
      dokkimiDir,
      'test.json',
      minimalDef('unresolved', [
        {
          type: 'SERVICE',
          name: 'svc',
          port: 3000,
          healthCheck: '/health',
          env: [{ name: 'KEY', value: '{{DOES_NOT_EXIST}}' }],
        },
      ]),
    );

    const result = resolveDefinitions(defPath);

    const errs = result.errors.filter((e) => e.errors.length > 0);
    expect(errs).toHaveLength(1);
    expect(errs[0].errors[0]).toContain('Unresolved variables');
    expect(errs[0].errors[0]).toContain('{{DOES_NOT_EXIST}}');
  });

  it('errors on dotted path references in items', () => {
    const defPath = writeFile(
      dokkimiDir,
      'test.json',
      minimalDef(
        'dotted',
        [
          {
            type: 'SERVICE',
            name: 'svc',
            port: 3000,
            healthCheck: '/health',
            env: [{ name: 'KEY', value: '{{obj.field}}' }],
          },
        ],
        { variables: { obj: 'something' } },
      ),
    );

    const result = resolveDefinitions(defPath);

    const errs = result.errors.filter((e) => e.errors.length > 0);
    expect(errs).toHaveLength(1);
    expect(errs[0].errors[0]).toContain('Invalid variable references');
    expect(errs[0].errors[0]).toContain('{{obj.field}}');
  });

  it('does not resolve {{VAR}} in test steps at build time', () => {
    const defPath = writeFile(dokkimiDir, 'test.json', {
      name: 'test-steps-untouched',
      items: [
        {
          type: 'SERVICE',
          name: 'svc',
          port: 3000,
          healthCheck: '/health',
        },
      ],
      variables: { baseUrl: 'http://svc:3000' },
      tests: [
        {
          name: 'my test',
          steps: [
            {
              name: 'call api',
              action: {
                type: 'httpRequest',
                method: 'GET',
                url: '{{baseUrl}}/api/data',
              },
            },
          ],
        },
      ],
    });

    const result = resolveDefinitions(defPath);

    expect(result.errors.filter((e) => e.errors.length > 0)).toEqual([]);
    const test = (result.definitions[0].definition.tests as any[])[0];
    expect(test.steps[0].action.url).toBe('{{baseUrl}}/api/data');
  });

  it('resolves multiple {{VAR}} references in a single string', () => {
    const defPath = writeFile(
      dokkimiDir,
      'test.json',
      minimalDef(
        'multi-ref',
        [
          {
            type: 'SERVICE',
            name: 'svc',
            port: 3000,
            healthCheck: '/health',
            env: [
              {
                name: 'DB_URL',
                value: 'postgres://{{USER}}:{{PASS}}@{{HOST}}:5432',
              },
            ],
          },
        ],
        { variables: { USER: 'admin', PASS: 'secret', HOST: 'my-db' } },
      ),
    );

    const result = resolveDefinitions(defPath);

    expect(result.errors.filter((e) => e.errors.length > 0)).toEqual([]);
    const item = (result.definitions[0].definition.items as any[])[0];
    expect(item.env[0].value).toBe('postgres://admin:secret@my-db:5432');
  });

  it('{{VAR}} and ${{VAR}} coexist in the same field', () => {
    writeFile(dokkimiDir, 'config.yaml', 'env:\n  SECRET: s3cret');
    const defPath = writeFile(
      dokkimiDir,
      'test.json',
      minimalDef(
        'coexist',
        [
          {
            type: 'SERVICE',
            name: 'svc',
            port: 3000,
            healthCheck: '/health',
            env: [
              {
                name: 'URL',
                value: 'redis://:${{SECRET}}@{{HOST}}:6379',
              },
            ],
          },
        ],
        { variables: { HOST: 'my-redis' } },
      ),
    );

    const result = resolveDefinitions(defPath);

    expect(result.errors.filter((e) => e.errors.length > 0)).toEqual([]);
    const item = (result.definitions[0].definition.items as any[])[0];
    expect(item.env[0].value).toBe('redis://:s3cret@my-redis:6379');
  });

  it('two-pass: {{VAR}} resolves to string containing ${{KEY}} which interpolateEnv then resolves', () => {
    writeFile(dokkimiDir, 'config.yaml', 'env:\n  PASSWORD: s3cret');
    const defPath = writeFile(
      dokkimiDir,
      'test.json',
      minimalDef(
        'two-pass',
        [
          {
            type: 'SERVICE',
            name: 'svc',
            port: 3000,
            healthCheck: '/health',
            env: [{ name: 'URL', value: '{{REDIS_URL}}' }],
          },
        ],
        {
          variables: { REDIS_URL: 'redis://:${{PASSWORD}}@my-redis:6379' },
        },
      ),
    );

    const result = resolveDefinitions(defPath);

    expect(result.errors.filter((e) => e.errors.length > 0)).toEqual([]);
    const item = (result.definitions[0].definition.items as any[])[0];
    expect(item.env[0].value).toBe('redis://:s3cret@my-redis:6379');
  });

  it('recursive resolution does not happen', () => {
    const defPath = writeFile(
      dokkimiDir,
      'test.json',
      minimalDef(
        'no-recurse',
        [
          {
            type: 'SERVICE',
            name: 'svc',
            port: 3000,
            healthCheck: '/health',
            env: [{ name: 'URL', value: '{{FULL_URL}}' }],
          },
        ],
        {
          variables: {
            HOST: 'my-redis',
            FULL_URL: 'redis://{{HOST}}:6379',
          },
        },
      ),
    );

    const result = resolveDefinitions(defPath);

    const errs = result.errors.filter((e) => e.errors.length > 0);
    expect(errs).toHaveLength(1);
    expect(errs[0].errors[0]).toContain('Invalid variable references');
    expect(errs[0].errors[0]).toContain('{{HOST}}');
  });
});

describe('files that are not definitions', () => {
  // Before, a definition with a mistake in "name" or "items" was skipped like
  // a fragment: no definitions, no errors, and `validate` said all was valid.
  it.each([
    [{ name: 123 }, 'missing or empty "name"'],
    [{ item: [] }, 'definition: unknown property "item"'],
  ])('reports a definition with %j', (broken, message) => {
    const dokkimiDir = createTempDokkimi();
    const { items: _items, ...def } = minimalDef('d');
    writeFile(dokkimiDir, 'd.json', { ...def, ...broken });
    const result = resolveDefinitions(dokkimiDir);
    expect(result.definitions).toHaveLength(0);
    expect(result.errors.flatMap((e) => e.errors)).toContain(message);
  });

  it('still skips fragments', () => {
    const dokkimiDir = createTempDokkimi();
    writeFile(dokkimiDir, 'shared/db.json', {
      type: 'DATABASE',
      name: 'db',
      database: 'postgres',
    });
    writeFile(dokkimiDir, 'shared/vars.json', { items: [1, 2] });
    writeFile(dokkimiDir, 'd.json', minimalDef('d'));
    const result = resolveDefinitions(dokkimiDir);
    expect(result.errors.flatMap((e) => e.errors)).toEqual([]);
    expect(result.definitions).toHaveLength(1);
  });
});

it('removes "$schema" before submitting', () => {
  const dokkimiDir = createTempDokkimi();
  writeFile(dokkimiDir, 'd.json', {
    $schema: './dokkimi.schema.json',
    ...minimalDef('d'),
  });
  const result = resolveDefinitions(dokkimiDir);
  expect(result.errors.flatMap((e) => e.errors)).toEqual([]);
  expect(result.definitions[0].definition).not.toHaveProperty('$schema');
});

describe('values are validated as they will run', () => {
  // Before, "{{PG}}" and "${{HC}}" were checked as written and rejected, and
  // a number variable was "unresolved"
  it('fills in variables and config env before validating', () => {
    const dokkimiDir = createTempDokkimi();
    writeFile(dokkimiDir, 'config.yaml', 'env:\n  HC: /health\n');
    writeFile(
      dokkimiDir,
      'd.json',
      minimalDef(
        'd',
        [
          {
            type: 'SERVICE',
            name: 'svc',
            image: 'x:1',
            port: 3000,
            healthCheck: '${{HC}}',
            env: [{ name: 'PORT', value: '{{PORT}}' }],
          },
          {
            type: 'DATABASE',
            name: 'db',
            database: 'postgres',
            version: '{{PG}}',
          },
        ],
        { variables: { PG: '16', PORT: 3000 } },
      ),
    );
    const result = resolveDefinitions(dokkimiDir);
    expect(result.errors.flatMap((e) => e.errors)).toEqual([]);
    const items = result.definitions[0].definition.items as any[];
    expect(items[0].healthCheck).toBe('/health');
    expect(items[0].env[0].value).toBe('3000');
    expect(items[1].version).toBe('16');
  });

  it('reports a bad value that came from a variable', () => {
    const dokkimiDir = createTempDokkimi();
    writeFile(
      dokkimiDir,
      'd.json',
      minimalDef(
        'd',
        [
          {
            type: 'DATABASE',
            name: 'db',
            database: 'postgres',
            version: '{{PG}}',
          },
        ],
        { variables: { PG: 'latest' } },
      ),
    );
    const errors = resolveDefinitions(dokkimiDir).errors.flatMap(
      (e) => e.errors,
    );
    expect(
      errors.some((e) => e.includes('"version" must start with a digit')),
    ).toBe(true);
  });
});

// Before, an override's path was resolved from the fragment's folder
it('reads an init file override from the definition, not the fragment', () => {
  const dokkimiDir = createTempDokkimi();
  writeFile(dokkimiDir, 'shared/pg.json', {
    type: 'DATABASE',
    name: 'db',
    database: 'postgres',
  });
  writeFile(dokkimiDir, 'shared/seed.sql', '-- shared seed');
  writeFile(dokkimiDir, 'defs/seed.sql', '-- definition seed');
  writeFile(
    dokkimiDir,
    'defs/d.json',
    minimalDef('d', [
      { $ref: '../shared/pg.json', initFilePath: './seed.sql' },
    ]),
  );
  const result = resolveDefinitions(dokkimiDir);
  expect(result.errors.flatMap((e) => e.errors)).toEqual([]);
  expect(
    result.definitions[0].initFiles.map((f) => f.content.toString()),
  ).toEqual(['-- definition seed']);
});

// Before, a directory crashed the resolver with EISDIR
it.each([
  ['mountFiles', { mountFiles: [{ source: './conf', target: '/etc/conf' }] }],
])('reports a directory given in %s', (_field, extra) => {
  const dokkimiDir = createTempDokkimi();
  fs.mkdirSync(path.join(dokkimiDir, 'conf'));
  writeFile(
    dokkimiDir,
    'd.json',
    minimalDef('d', [
      {
        type: 'SERVICE',
        name: 'svc',
        image: 'x:1',
        port: 3000,
        healthCheck: '/health',
        ...extra,
      },
    ]),
  );
  const errors = resolveDefinitions(dokkimiDir).errors.flatMap((e) => e.errors);
  expect(errors).toEqual([
    'Mount file "./conf" is not a file — mount each file separately',
  ]);
});

// Before, Control Tower rejected the run with a 400 after it was submitted
it('reports an init file over the limit before submitting', () => {
  const dokkimiDir = createTempDokkimi();
  writeFile(dokkimiDir, 'big.sql', 'x'.repeat(MAX_FILE_BYTES + 1));
  writeFile(
    dokkimiDir,
    'd.json',
    minimalDef('d', [
      {
        type: 'DATABASE',
        name: 'db',
        database: 'postgres',
        initFilePath: './big.sql',
      },
    ]),
  );
  const errors = resolveDefinitions(dokkimiDir).errors.flatMap((e) => e.errors);
  expect(errors).toEqual([
    'Init file "./big.sql" is 7.6 MB; files are limited to 7.5 MB',
  ]);
});
