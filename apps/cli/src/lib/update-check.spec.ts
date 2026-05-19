import * as path from 'path';
import * as os from 'os';

const CHECK_FILE = path.join(os.homedir(), '.dokkimi', 'update-check.json');

// Mock fs at the module level
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
    writeFileSync: jest.fn(),
    mkdirSync: jest.fn(),
  };
});

const mockConfig = { DOKKIMI_VERSION: '1.0.0' };
jest.mock('@dokkimi/config', () => mockConfig);

import * as fs from 'fs';
import { checkForUpdate } from './update-check';

const mockExistsSync = fs.existsSync as jest.Mock;
const mockReadFileSync = fs.readFileSync as jest.Mock;
const mockWriteFileSync = fs.writeFileSync as jest.Mock;

describe('update-check', () => {
  let consoleSpy: jest.SpyInstance;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    originalFetch = globalThis.fetch;
    jest.clearAllMocks();
    mockConfig.DOKKIMI_VERSION = '1.0.0';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function flushPromises(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  describe('cached version path', () => {
    it('prints banner when cache has a newer version and is fresh', async () => {
      const state = {
        lastCheck: Date.now() - 1000,
        latestVersion: '999.0.0',
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(state));
      globalThis.fetch = jest.fn();

      await checkForUpdate();

      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(consoleSpy.mock.calls[0][0]).toContain('999.0.0');
      expect(consoleSpy.mock.calls[0][0]).toContain('Update available');
    });

    it('does not print banner when cache has same version', async () => {
      const state = {
        lastCheck: Date.now() - 1000,
        latestVersion: '1.0.0',
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(state));
      globalThis.fetch = jest.fn();

      await checkForUpdate();

      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('does not print banner when cache has older version', async () => {
      const state = {
        lastCheck: Date.now() - 1000,
        latestVersion: '0.0.1',
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(state));
      globalThis.fetch = jest.fn();

      await checkForUpdate();

      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  describe('stale cache / no cache path', () => {
    it('fetches from npm when cache is stale', async () => {
      const staleState = {
        lastCheck: Date.now() - 25 * 60 * 60 * 1000,
        latestVersion: '1.0.0',
      };

      mockExistsSync.mockImplementation((p: string) => {
        if (p === CHECK_FILE) {
          return true;
        }
        return true;
      });
      mockReadFileSync.mockReturnValue(JSON.stringify(staleState));

      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '999.0.0' }),
      });

      await checkForUpdate();
      await flushPromises();

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(consoleSpy.mock.calls[0][0]).toContain('999.0.0');
    });

    it('fetches from npm when no cache file exists', async () => {
      mockExistsSync.mockImplementation((p: string) => {
        if (p === CHECK_FILE) {
          return false;
        }
        return true;
      });

      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '1.0.0' }),
      });

      await checkForUpdate();
      await flushPromises();

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(consoleSpy).not.toHaveBeenCalled();
      expect(mockWriteFileSync).toHaveBeenCalled();
    });

    it('does not throw when fetch rejects', async () => {
      mockExistsSync.mockReturnValue(false);
      globalThis.fetch = jest.fn().mockRejectedValue(new Error('network down'));

      await checkForUpdate();
      await flushPromises();

      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('writes cache without version when fetch returns non-ok', async () => {
      mockExistsSync.mockImplementation((p: string) => {
        if (p === CHECK_FILE) {
          return false;
        }
        return true;
      });

      globalThis.fetch = jest.fn().mockResolvedValue({ ok: false });

      await checkForUpdate();
      await flushPromises();

      expect(mockWriteFileSync).toHaveBeenCalled();
      const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(written.latestVersion).toBeUndefined();
      expect(written.lastCheck).toBeDefined();
    });
  });

  describe('corrupt cache', () => {
    it('treats corrupt cache as missing and fetches', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('NOT VALID JSON!!!');

      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '1.0.0' }),
      });

      await checkForUpdate();
      await flushPromises();

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
  });
});
