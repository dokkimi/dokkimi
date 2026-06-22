import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  filterFilesByPattern,
  findDokkimiDir,
  findDokkimiDirFrom,
  collectInitFilePaths,
  loadDokignore,
  scanDefinitionFiles,
} from './glob-resolver';

function createTempDir(): string {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'dokkimi-glob-test-')),
  );
}

function touch(dir: string, relPath: string): string {
  const absPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, '{}');
  return absPath;
}

describe('findDokkimiDir', () => {
  it('returns .dokkimi when file is directly inside it', () => {
    const result = findDokkimiDir('/project/.dokkimi/test.yaml');
    expect(result).toBe('/project/.dokkimi');
  });

  it('returns .dokkimi when file is in a subdirectory', () => {
    const result = findDokkimiDir('/project/.dokkimi/auth/login.json');
    expect(result).toBe('/project/.dokkimi');
  });

  it('returns null when no .dokkimi ancestor exists', () => {
    const result = findDokkimiDir('/some/other/path/test.yaml');
    expect(result).toBeNull();
  });
});

describe('findDokkimiDirFrom', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns dir itself if named .dokkimi', () => {
    const dokkimiDir = path.join(tmp, '.dokkimi');
    fs.mkdirSync(dokkimiDir);
    expect(findDokkimiDirFrom(dokkimiDir)).toBe(dokkimiDir);
  });

  it('returns .dokkimi child if dir contains one', () => {
    const dokkimiDir = path.join(tmp, '.dokkimi');
    fs.mkdirSync(dokkimiDir);
    expect(findDokkimiDirFrom(tmp)).toBe(dokkimiDir);
  });

  it('walks up to find .dokkimi in a parent', () => {
    const dokkimiDir = path.join(tmp, '.dokkimi');
    fs.mkdirSync(dokkimiDir);
    const subDir = path.join(tmp, 'src', 'lib');
    fs.mkdirSync(subDir, { recursive: true });
    expect(findDokkimiDirFrom(subDir)).toBe(dokkimiDir);
  });

  it('returns null when no .dokkimi exists anywhere', () => {
    const isolated = createTempDir();
    try {
      expect(findDokkimiDirFrom(isolated)).toBeNull();
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });
});

describe('filterFilesByPattern', () => {
  const dokkimiDir = '/project/.dokkimi';
  const files = [
    '/project/.dokkimi/auth/login.json',
    '/project/.dokkimi/auth/signup.yaml',
    '/project/.dokkimi/payments/checkout.json',
    '/project/.dokkimi/payments/refund.yaml',
    '/project/.dokkimi/users.json',
  ];

  it('filters by substring match (case-insensitive)', () => {
    const result = filterFilesByPattern(files, dokkimiDir, 'auth');
    expect(result).toEqual([
      '/project/.dokkimi/auth/login.json',
      '/project/.dokkimi/auth/signup.yaml',
    ]);
  });

  it('matches basename without extension', () => {
    const result = filterFilesByPattern(files, dokkimiDir, 'login');
    expect(result).toEqual(['/project/.dokkimi/auth/login.json']);
  });

  it('is case-insensitive for substring', () => {
    const result = filterFilesByPattern(files, dokkimiDir, 'LOGIN');
    expect(result).toEqual(['/project/.dokkimi/auth/login.json']);
  });

  it('filters by glob pattern', () => {
    const result = filterFilesByPattern(files, dokkimiDir, '*.json');
    expect(result).toEqual([
      '/project/.dokkimi/auth/login.json',
      '/project/.dokkimi/payments/checkout.json',
      '/project/.dokkimi/users.json',
    ]);
  });

  it('filters by directory glob', () => {
    const result = filterFilesByPattern(files, dokkimiDir, 'payments/*');
    expect(result).toEqual([
      '/project/.dokkimi/payments/checkout.json',
      '/project/.dokkimi/payments/refund.yaml',
    ]);
  });

  it('filters by explicit regex pattern', () => {
    const result = filterFilesByPattern(
      files,
      dokkimiDir,
      '/^payments\\/check/',
    );
    expect(result).toEqual(['/project/.dokkimi/payments/checkout.json']);
  });

  it('returns empty array when nothing matches', () => {
    const result = filterFilesByPattern(files, dokkimiDir, 'nonexistent');
    expect(result).toEqual([]);
  });

  it('returns all files when pattern matches everything', () => {
    const result = filterFilesByPattern(files, dokkimiDir, '.');
    expect(result).toEqual(files);
  });
});

describe('collectInitFilePaths', () => {
  it('returns empty array when no init fields exist', () => {
    expect(collectInitFilePaths({ name: 'db', type: 'DATABASE' })).toEqual([]);
  });

  it('collects single initFilePath', () => {
    const result = collectInitFilePaths({ initFilePath: 'init.sql' });
    expect(result).toEqual(['init.sql']);
  });

  it('collects initFilePaths array', () => {
    const result = collectInitFilePaths({
      initFilePaths: ['schema.sql', 'seed.sql'],
    });
    expect(result).toEqual(['schema.sql', 'seed.sql']);
  });

  it('collects both initFilePath and initFilePaths', () => {
    const result = collectInitFilePaths({
      initFilePath: 'init.sql',
      initFilePaths: ['extra.sql'],
    });
    expect(result).toEqual(['init.sql', 'extra.sql']);
  });

  it('ignores non-string entries in initFilePaths', () => {
    const result = collectInitFilePaths({
      initFilePaths: ['valid.sql', 42, null, 'also-valid.sql'],
    });
    expect(result).toEqual(['valid.sql', 'also-valid.sql']);
  });
});

describe('loadDokignore', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns empty rules when no .dokignore exists', () => {
    const rules = loadDokignore(tmp);
    expect(rules.exact.size).toBe(0);
    expect(rules.globs).toEqual([]);
  });

  it('parses exact names and glob patterns', () => {
    fs.writeFileSync(
      path.join(tmp, '.dokignore'),
      'scratch.json\n*.tmp\n# comment\n\nbackup/*.yaml\n',
    );
    const rules = loadDokignore(tmp);
    expect(rules.exact).toEqual(new Set(['scratch.json']));
    expect(rules.globs).toEqual(['*.tmp', 'backup/*.yaml']);
  });
});

describe('scanDefinitionFiles', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('finds json and yaml files', () => {
    touch(tmp, 'test.json');
    touch(tmp, 'other.yaml');
    touch(tmp, 'third.yml');
    touch(tmp, 'readme.md');

    const files = scanDefinitionFiles(tmp).map((f) => path.basename(f));
    expect(files.sort()).toEqual(['other.yaml', 'test.json', 'third.yml']);
  });

  it('recurses into subdirectories', () => {
    touch(tmp, 'auth/login.json');
    touch(tmp, 'payments/checkout.yaml');

    const files = scanDefinitionFiles(tmp).map((f) => path.relative(tmp, f));
    expect(files.sort()).toEqual(['auth/login.json', 'payments/checkout.yaml']);
  });

  it('skips dotfiles and dotdirs', () => {
    touch(tmp, '.hidden/secret.json');
    touch(tmp, '.config.json');
    touch(tmp, 'visible.json');

    const files = scanDefinitionFiles(tmp).map((f) => path.basename(f));
    expect(files).toEqual(['visible.json']);
  });

  it('respects ignore rules', () => {
    touch(tmp, 'keep.json');
    touch(tmp, 'skip.json');
    fs.writeFileSync(path.join(tmp, '.dokignore'), 'skip.json\n');

    const files = scanDefinitionFiles(tmp).map((f) => path.basename(f));
    expect(files).toEqual(['keep.json']);
  });
});
