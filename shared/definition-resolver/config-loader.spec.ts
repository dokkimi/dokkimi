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

  it('coerces numeric dokkimi version to string', () => {
    fs.writeFileSync(
      path.join(tmp, 'config.json'),
      JSON.stringify({ dokkimi: 1 }),
    );
    const result = loadDokkimiConfig(tmp, errors);
    expect(result.dokkimi).toBe('1');
    expect(errors).toEqual([]);
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

  it('reports error when env value is not string or number', () => {
    fs.writeFileSync(
      path.join(tmp, 'config.json'),
      JSON.stringify({ env: { KEY: true } }),
    );
    const result = loadDokkimiConfig(tmp, errors);
    expect(result).toEqual({ env: {} });
    expect(errors[0].errors[0]).toMatch(/env key "KEY" must be a string/);
  });

  it('coerces numeric env values to string', () => {
    fs.writeFileSync(
      path.join(tmp, 'config.json'),
      JSON.stringify({ env: { PORT: 3000 } }),
    );
    const result = loadDokkimiConfig(tmp, errors);
    expect(result.env.PORT).toBe('3000');
    expect(errors).toEqual([]);
  });
});
