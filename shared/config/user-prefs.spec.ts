import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Loads user-prefs with ~ in a temporary folder, and the prefs file holding raw
function withPrefsFile(
  raw: string | null,
  fn: (prefs: typeof import('./user-prefs'), file: string) => void,
): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dokkimi-prefs-'));
  const file = path.join(home, '.dokkimi', 'config.json');
  if (raw !== null) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, raw);
  }
  try {
    jest.isolateModules(() => {
      // Under Jest, os.homedir() doesn't follow a changed HOME
      jest.doMock('os', () => ({
        ...jest.requireActual('os'),
        homedir: () => home,
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const prefs = require('./user-prefs');
      if (!prefs.prefsFilePath().startsWith(home)) {
        throw new Error('the prefs file is not in the test folder');
      }
      fn(prefs, file);
    });
  } finally {
    jest.dontMock('os');
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('user prefs', () => {
  // Before, a file that couldn't be parsed was read as empty and the next
  // write replaced it: every setting was lost and telemetry was back on.
  it('never writes over a file it cannot read', () => {
    const broken = '{ "telemetry": { "enabled": false }, }';
    withPrefsFile(broken, (prefs, file) => {
      expect(() =>
        prefs.setConcurrencyPrefs({ maxConcurrentTests: 2 }),
      ).toThrow("can't be read");
      expect(fs.readFileSync(file, 'utf-8')).toBe(broken);
    });
  });

  it('treats telemetry as off when the file cannot be read', () => {
    withPrefsFile('not json', (prefs) => {
      expect(prefs.getTelemetryPrefs()?.enabled).toBe(false);
    });
  });

  it('creates the file when there is none', () => {
    withPrefsFile(null, (prefs, file) => {
      expect(prefs.getTelemetryPrefs()).toBeUndefined();
      prefs.setConcurrencyPrefs({ maxConcurrentTests: 2 });
      expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({
        concurrency: { maxConcurrentTests: 2 },
      });
      expect(fs.readdirSync(path.dirname(file))).toEqual(['config.json']);
    });
  });
});

describe('resolveConcurrency', () => {
  const fileConfig = {
    concurrency: { maxConcurrentTests: 6, maxBootingTests: 2 },
  };
  const saved = JSON.stringify({
    concurrency: { maxConcurrentTests: 3, maxBootingTests: 1 },
  });

  afterEach(() => {
    delete process.env.DOKKIMI_MAX_CONCURRENT_NAMESPACES;
    delete process.env.DOKKIMI_MAX_BOOTING_NAMESPACES;
  });

  // Before, a saved setting won over the environment variables
  it('lets an environment variable win over a saved setting', () => {
    withPrefsFile(saved, (prefs) => {
      process.env.DOKKIMI_MAX_CONCURRENT_NAMESPACES = '8';
      // The loader has applied the variable to the config
      const config = {
        concurrency: { maxConcurrentTests: 8, maxBootingTests: 2 },
      };
      expect(prefs.resolveConcurrency(config)).toEqual({
        maxConcurrentTests: 8,
        maxBootingTests: 1,
      });
    });
  });

  it('uses a saved setting over the config file', () => {
    withPrefsFile(saved, (prefs) => {
      expect(prefs.resolveConcurrency(fileConfig)).toEqual({
        maxConcurrentTests: 3,
        maxBootingTests: 1,
      });
    });
  });

  it('falls back to the config file', () => {
    withPrefsFile(null, (prefs) => {
      expect(prefs.resolveConcurrency(fileConfig)).toEqual(
        fileConfig.concurrency,
      );
    });
  });

  it('describes a difference, and none when equal', () => {
    withPrefsFile(null, (prefs) => {
      const a = { maxConcurrentTests: 6, maxBootingTests: 2 };
      expect(prefs.concurrencyDifference(a, { ...a })).toBeNull();
      expect(
        prefs.concurrencyDifference(a, {
          maxConcurrentTests: 4,
          maxBootingTests: 2,
        }),
      ).toBe('concurrency 6 parallel, 2 booting, not 4 parallel, 2 booting');
    });
  });
});
