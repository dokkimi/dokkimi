import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadDokkimiConfig } from './config-loader';
import type { ResolverError } from './resolve';

function createTempDir(): string {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'dokkimi-config-test-')),
  );
}

describe('loadDokkimiConfig', () => {
  let tmp: string;
  let errors: ResolverError[];

  beforeEach(() => {
    tmp = createTempDir();
    errors = [];
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns default config when no config file exists', () => {
    const result = loadDokkimiConfig(tmp, errors);
    expect(result).toEqual({ env: {} });
    expect(errors).toEqual([]);
  });

  it('loads config.yaml', () => {
    fs.writeFileSync(
      path.join(tmp, 'config.yaml'),
      'dokkimi: "1.0.0"\nenv:\n  API_KEY: abc123\n',
    );
    const result = loadDokkimiConfig(tmp, errors);
    expect(result.dokkimi).toBe('1.0.0');
    expect(result.env).toEqual({ API_KEY: 'abc123' });
    expect(errors).toEqual([]);
  });

  it('loads config.json', () => {
    fs.writeFileSync(
      path.join(tmp, 'config.json'),
      JSON.stringify({ env: { PORT: '3000' } }),
    );
    const result = loadDokkimiConfig(tmp, errors);
    expect(result.env).toEqual({ PORT: '3000' });
    expect(errors).toEqual([]);
  });

  it('prefers config.yaml over config.json', () => {
    fs.writeFileSync(path.join(tmp, 'config.yaml'), 'env:\n  FROM: yaml\n');
    fs.writeFileSync(
      path.join(tmp, 'config.json'),
      JSON.stringify({ env: { FROM: 'json' } }),
    );
    const result = loadDokkimiConfig(tmp, errors);
    expect(result.env.FROM).toBe('yaml');
  });

  it('reports error for unparseable YAML', () => {
    fs.writeFileSync(path.join(tmp, 'config.yaml'), ':\n  :\n  - [invalid');
    const result = loadDokkimiConfig(tmp, errors);
    expect(result).toEqual({ env: {} });
    expect(errors.length).toBe(1);
    expect(errors[0].errors[0]).toMatch(/Failed to parse config/);
  });

  it('reports error for bare array config', () => {
    fs.writeFileSync(
      path.join(tmp, 'config.json'),
      JSON.stringify(['not', 'an', 'object']),
    );
    const result = loadDokkimiConfig(tmp, errors);
    expect(result).toEqual({ env: {} });
    expect(errors.length).toBe(1);
    expect(errors[0].errors[0]).toMatch(
      /Config must be a YAML\/JSON object.*array/,
    );
  });

  it('reports error for bare string config', () => {
    fs.writeFileSync(path.join(tmp, 'config.yaml'), '"just a string"');
    const result = loadDokkimiConfig(tmp, errors);
    expect(result).toEqual({ env: {} });
    expect(errors.length).toBe(1);
    expect(errors[0].errors[0]).toMatch(/Config must be a YAML\/JSON object/);
  });

  it('reports error when dokkimi field is wrong type', () => {
    fs.writeFileSync(
      path.join(tmp, 'config.json'),
      JSON.stringify({ dokkimi: ['wrong'] }),
    );
    const result = loadDokkimiConfig(tmp, errors);
    expect(result).toEqual({ env: {} });
    expect(errors[0].errors[0]).toMatch(/dokkimi.*version string/);
  });

  it('rejects a numeric dokkimi version', () => {
    fs.writeFileSync(
      path.join(tmp, 'config.json'),
      JSON.stringify({ dokkimi: 1 }),
    );
    const result = loadDokkimiConfig(tmp, errors);
    expect(result).toEqual({ env: {} });
    expect(errors[0].errors).toEqual([
      '"dokkimi" must be a version string — quote it: dokkimi: "1"',
    ]);
  });

  it('reports error when env is an array', () => {
    fs.writeFileSync(
      path.join(tmp, 'config.json'),
      JSON.stringify({ env: ['nope'] }),
    );
    const result = loadDokkimiConfig(tmp, errors);
    expect(result).toEqual({ env: {} });
    expect(errors[0].errors[0]).toMatch(/env.*plain object/);
  });

  it('reports error for invalid env key', () => {
    fs.writeFileSync(
      path.join(tmp, 'config.json'),
      JSON.stringify({ env: { 'bad-key': 'value' } }),
    );
    const result = loadDokkimiConfig(tmp, errors);
    expect(result).toEqual({ env: {} });
    expect(errors[0].errors[0]).toMatch(/env key.*alphanumeric/);
  });

  it('reports error when env value is not a string', () => {
    fs.writeFileSync(
      path.join(tmp, 'config.json'),
      JSON.stringify({ env: { KEY: { a: 1 } } }),
    );
    const result = loadDokkimiConfig(tmp, errors);
    expect(result).toEqual({ env: {} });
    expect(errors[0].errors[0]).toBe('env "KEY" must be a string, got object');
  });

  // A YAML number has already lost its text: TAG: 1.10 is read as 1.1.
  // Before, it was used as "1.1".
  it.each([
    ['TAG: 1.10', 'env "TAG" must be a string — quote it: TAG: "1.1"'],
    ['DEBUG: true', 'env "DEBUG" must be a string — quote it: DEBUG: "true"'],
  ])('rejects an env value that is not quoted: %s', (line, message) => {
    fs.writeFileSync(path.join(tmp, 'config.yaml'), `env:\n  ${line}\n`);
    const result = loadDokkimiConfig(tmp, errors);
    expect(result).toEqual({ env: {} });
    expect(errors[0].errors).toEqual([message]);
  });

  it('accepts a quoted env value as written', () => {
    fs.writeFileSync(path.join(tmp, 'config.yaml'), 'env:\n  TAG: "1.10"\n');
    expect(loadDokkimiConfig(tmp, errors).env.TAG).toBe('1.10');
    expect(errors).toEqual([]);
  });
});
