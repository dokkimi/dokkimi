import { getCliVersion, warnIfVersionMismatch } from './version';
import type { DokkimiConfig } from '@dokkimi/definition-resolver';

describe('version', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getCliVersion', () => {
    it('returns a version string', () => {
      const version = getCliVersion();
      // Should be either a semver string or 'unknown'
      expect(typeof version).toBe('string');
      expect(version.length).toBeGreaterThan(0);
    });

    it('returns the same value on subsequent calls (caching)', () => {
      const first = getCliVersion();
      const second = getCliVersion();
      expect(first).toBe(second);
    });
  });

  describe('warnIfVersionMismatch', () => {
    it('does not warn when config.dokkimi is missing', () => {
      const config = {} as DokkimiConfig;
      warnIfVersionMismatch(config);
      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('does not warn when config.dokkimi is undefined', () => {
      const config = { dokkimi: undefined } as unknown as DokkimiConfig;
      warnIfVersionMismatch(config);
      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('warns when config version is much newer than CLI', () => {
      // Use a version that is certainly newer than any real CLI version
      const config = { dokkimi: '999.0.0' } as DokkimiConfig;
      warnIfVersionMismatch(config);

      const cliVersion = getCliVersion();
      if (cliVersion === 'unknown') {
        // If CLI version is unknown, no warning is printed
        expect(consoleSpy).not.toHaveBeenCalled();
      } else {
        expect(consoleSpy).toHaveBeenCalledTimes(1);
        const message = consoleSpy.mock.calls[0][0] as string;
        expect(message).toContain('Warning');
        expect(message).toContain('999.0.0');
        expect(message).toContain(cliVersion);
        expect(message).toContain('brew upgrade dokkimi');
      }
    });

    it('warns when config minor version is newer', () => {
      const cliVersion = getCliVersion();
      if (cliVersion === 'unknown') {
        return; // Skip: can't construct a "newer" version without knowing current
      }
      const parts = cliVersion.split('.').map(Number);
      const newerMinor = `${parts[0]}.${parts[1] + 100}.0`;
      const config = { dokkimi: newerMinor } as DokkimiConfig;
      warnIfVersionMismatch(config);
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    });

    it('warns when config patch version is newer', () => {
      const cliVersion = getCliVersion();
      if (cliVersion === 'unknown') {
        return;
      }
      const parts = cliVersion.split('.').map(Number);
      const newerPatch = `${parts[0]}.${parts[1]}.${parts[2] + 100}`;
      const config = { dokkimi: newerPatch } as DokkimiConfig;
      warnIfVersionMismatch(config);
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    });

    it('does not warn when CLI is newer', () => {
      const config = { dokkimi: '0.0.1' } as DokkimiConfig;
      warnIfVersionMismatch(config);

      const cliVersion = getCliVersion();
      if (cliVersion === 'unknown') {
        expect(consoleSpy).not.toHaveBeenCalled();
      } else {
        // 0.0.1 should be older than any real CLI version
        expect(consoleSpy).not.toHaveBeenCalled();
      }
    });

    it('does not warn when versions match', () => {
      const cliVersion = getCliVersion();
      if (cliVersion === 'unknown') {
        return;
      }
      const config = { dokkimi: cliVersion } as DokkimiConfig;
      warnIfVersionMismatch(config);
      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });
});
