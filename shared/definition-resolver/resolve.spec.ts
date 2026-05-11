import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveDefinitions } from './resolve';

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
  return { name, items: finalItems, ...extra };
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
        tests: [],
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
