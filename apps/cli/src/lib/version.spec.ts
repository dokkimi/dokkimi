import { DOKKIMI_VERSION } from '@dokkimi/config';
import { warnIfVersionMismatch } from './version';
import type { DokkimiConfig } from '@dokkimi/definition-resolver';

describe('version', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
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
      const config = { dokkimi: '999.0.0' } as DokkimiConfig;
      warnIfVersionMismatch(config);

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const message = consoleSpy.mock.calls[0][0] as string;
      expect(message).toContain('Warning');
      expect(message).toContain('999.0.0');
      expect(message).toContain(DOKKIMI_VERSION);
      expect(message).toContain('brew upgrade dokkimi');
    });

    it('warns when config minor version is newer', () => {
      const parts = DOKKIMI_VERSION.split('.').map(Number);
      const newerMinor = `${parts[0]}.${parts[1] + 100}.0`;
      const config = { dokkimi: newerMinor } as DokkimiConfig;
      warnIfVersionMismatch(config);
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    });

    it('warns when config patch version is newer', () => {
      const parts = DOKKIMI_VERSION.split('.').map(Number);
      const newerPatch = `${parts[0]}.${parts[1]}.${parts[2] + 100}`;
      const config = { dokkimi: newerPatch } as DokkimiConfig;
      warnIfVersionMismatch(config);
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    });

    it('does not warn when CLI is newer', () => {
      const config = { dokkimi: '0.0.1' } as DokkimiConfig;
      warnIfVersionMismatch(config);
      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('does not warn when versions match', () => {
      const config = { dokkimi: DOKKIMI_VERSION } as DokkimiConfig;
      warnIfVersionMismatch(config);
      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });
});
