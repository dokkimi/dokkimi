jest.mock('fs');

import * as fs from 'fs';
import * as path from 'path';
import {
  findBaselinesDir,
  listBaselineFiles,
  extractVisualMatchNames,
  uploadBaseline,
  uploadBaselinesForDefinition,
} from './baseline-upload';

const fsMock = fs as jest.Mocked<typeof fs>;

describe('baseline-upload', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // findBaselinesDir
  // -------------------------------------------------------------------------

  describe('findBaselinesDir', () => {
    it('finds baselines dir at same level as source', () => {
      const sourceFile = '/project/.dokkimi/myproj/definitions/test.yaml';
      const candidate = path.join(
        '/project/.dokkimi/myproj/definitions',
        'baselines',
      );

      fsMock.existsSync.mockImplementation((p) => p === candidate);
      fsMock.statSync.mockReturnValue({
        isDirectory: () => true,
      } as fs.Stats);

      expect(findBaselinesDir(sourceFile)).toBe(candidate);
    });

    it('finds baselines dir one level up', () => {
      const sourceFile = '/project/.dokkimi/myproj/definitions/test.yaml';
      const candidate = path.join('/project/.dokkimi/myproj', 'baselines');

      fsMock.existsSync.mockImplementation((p) => p === candidate);
      fsMock.statSync.mockReturnValue({
        isDirectory: () => true,
      } as fs.Stats);

      expect(findBaselinesDir(sourceFile)).toBe(candidate);
    });

    it('finds baselines dir two levels up', () => {
      const sourceFile = '/project/.dokkimi/myproj/definitions/test.yaml';
      const candidate = path.join('/project/.dokkimi', 'baselines');

      fsMock.existsSync.mockImplementation((p) => p === candidate);
      fsMock.statSync.mockReturnValue({
        isDirectory: () => true,
      } as fs.Stats);

      expect(findBaselinesDir(sourceFile)).toBe(candidate);
    });

    it('returns null when not found within 3 levels', () => {
      fsMock.existsSync.mockReturnValue(false);
      expect(findBaselinesDir('/a/b/c/d/test.yaml')).toBeNull();
    });

    it('returns null when candidate exists but is not a directory', () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.statSync.mockReturnValue({
        isDirectory: () => false,
      } as fs.Stats);

      expect(findBaselinesDir('/project/test.yaml')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // listBaselineFiles
  // -------------------------------------------------------------------------

  describe('listBaselineFiles', () => {
    it('returns PNG files with name (stem) and path', () => {
      fsMock.readdirSync.mockReturnValue([
        { name: 'login-page.png', isFile: () => true },
        { name: 'dashboard.png', isFile: () => true },
      ] as any);

      const result = listBaselineFiles('/baselines');
      expect(result).toEqual([
        { name: 'login-page', path: '/baselines/login-page.png' },
        { name: 'dashboard', path: '/baselines/dashboard.png' },
      ]);
    });

    it('ignores non-PNG files', () => {
      fsMock.readdirSync.mockReturnValue([
        { name: 'readme.txt', isFile: () => true },
        { name: 'screenshot.png', isFile: () => true },
        { name: 'data.json', isFile: () => true },
      ] as any);

      const result = listBaselineFiles('/baselines');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('screenshot');
    });

    it('ignores directories', () => {
      fsMock.readdirSync.mockReturnValue([
        { name: 'subdir.png', isFile: () => false },
        { name: 'real.png', isFile: () => true },
      ] as any);

      const result = listBaselineFiles('/baselines');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('real');
    });

    it('returns empty for empty dir', () => {
      fsMock.readdirSync.mockReturnValue([] as any);
      expect(listBaselineFiles('/baselines')).toEqual([]);
    });

    it('is case-insensitive on .png extension', () => {
      fsMock.readdirSync.mockReturnValue([
        { name: 'upper.PNG', isFile: () => true },
        { name: 'mixed.Png', isFile: () => true },
      ] as any);

      const result = listBaselineFiles('/baselines');
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('upper');
      expect(result[1].name).toBe('mixed');
    });
  });

  // -------------------------------------------------------------------------
  // extractVisualMatchNames
  // -------------------------------------------------------------------------

  describe('extractVisualMatchNames', () => {
    it('extracts names from screenshot steps with match blocks', () => {
      const definition = {
        tests: [
          {
            name: 'visual test',
            steps: [
              {
                action: {
                  type: 'ui',
                  steps: [
                    {
                      screenshot: {
                        name: 'login-page',
                        match: { threshold: 0.1 },
                      },
                    },
                    {
                      screenshot: {
                        name: 'dashboard',
                        match: { threshold: 0.05 },
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const names = extractVisualMatchNames(definition);
      expect(names).toEqual(new Set(['login-page', 'dashboard']));
    });

    it('returns empty set for no tests', () => {
      expect(extractVisualMatchNames({})).toEqual(new Set());
    });

    it('returns empty set for no UI steps', () => {
      const definition = {
        tests: [
          {
            steps: [
              {
                action: { type: 'httpCall', method: 'GET', url: '/api' },
              },
            ],
          },
        ],
      };
      expect(extractVisualMatchNames(definition)).toEqual(new Set());
    });

    it('returns empty set for screenshots without match', () => {
      const definition = {
        tests: [
          {
            steps: [
              {
                action: {
                  type: 'ui',
                  steps: [
                    {
                      screenshot: { name: 'no-match-screenshot' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
      expect(extractVisualMatchNames(definition)).toEqual(new Set());
    });

    it('handles nested ui action steps correctly', () => {
      const definition = {
        tests: [
          {
            steps: [
              {
                action: {
                  type: 'ui',
                  steps: [
                    { click: { selector: '#btn' } },
                    {
                      screenshot: {
                        name: 'after-click',
                        match: { threshold: 0.1 },
                      },
                    },
                    { type: { selector: '#input', text: 'hello' } },
                  ],
                },
              },
            ],
          },
          {
            steps: [
              {
                action: {
                  type: 'ui',
                  steps: [
                    {
                      screenshot: {
                        name: 'second-test',
                        match: { threshold: 0.02 },
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const names = extractVisualMatchNames(definition);
      expect(names).toEqual(new Set(['after-click', 'second-test']));
    });
  });

  // -------------------------------------------------------------------------
  // uploadBaseline
  // -------------------------------------------------------------------------

  describe('uploadBaseline', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      fsMock.readFileSync.mockReturnValue(Buffer.from('fake-png-data'));
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('returns null on success', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
      }) as jest.Mock;

      const result = await uploadBaseline(
        'http://localhost:19001',
        'inst-1',
        'login-page',
        '/baselines/login-page.png',
      );
      expect(result).toBeNull();
    });

    it('returns detail message on HTTP error', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ message: 'Invalid baseline' }),
      }) as jest.Mock;

      const result = await uploadBaseline(
        'http://localhost:19001',
        'inst-1',
        'login-page',
        '/baselines/login-page.png',
      );
      expect(result).toBe('Invalid baseline');
    });

    it('returns timeout error message on timeout', async () => {
      const timeoutError = new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      );
      global.fetch = jest.fn().mockRejectedValue(timeoutError) as jest.Mock;

      const result = await uploadBaseline(
        'http://localhost:19001',
        'inst-1',
        'login-page',
        '/baselines/login-page.png',
      );
      expect(result).toBe(
        'Request timed out — Control Tower may not be running',
      );
    });
  });

  // -------------------------------------------------------------------------
  // uploadBaselinesForDefinition
  // -------------------------------------------------------------------------

  describe('uploadBaselinesForDefinition', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('returns 0 when no baselines dir found', async () => {
      fsMock.existsSync.mockReturnValue(false);

      const result = await uploadBaselinesForDefinition(
        'http://localhost:19001',
        'inst-1',
        '/project/test.yaml',
      );
      expect(result).toBe(0);
    });

    it('returns 0 when baselines dir is empty', async () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.statSync.mockReturnValue({
        isDirectory: () => true,
      } as fs.Stats);
      fsMock.readdirSync.mockReturnValue([] as any);

      const result = await uploadBaselinesForDefinition(
        'http://localhost:19001',
        'inst-1',
        '/project/test.yaml',
      );
      expect(result).toBe(0);
    });

    it('uploads only files matching visual match names', async () => {
      // findBaselinesDir will find baselines at same level
      const baselinesDir = path.join('/project', 'baselines');
      fsMock.existsSync.mockImplementation((p) => p === baselinesDir);
      fsMock.statSync.mockReturnValue({
        isDirectory: () => true,
      } as fs.Stats);
      fsMock.readdirSync.mockReturnValue([
        { name: 'login-page.png', isFile: () => true },
        { name: 'dashboard.png', isFile: () => true },
        { name: 'unused.png', isFile: () => true },
      ] as any);
      fsMock.readFileSync.mockReturnValue(Buffer.from('png-data'));

      global.fetch = jest.fn().mockResolvedValue({ ok: true }) as jest.Mock;

      const definition = {
        tests: [
          {
            steps: [
              {
                action: {
                  type: 'ui',
                  steps: [
                    {
                      screenshot: {
                        name: 'login-page',
                        match: { threshold: 0.1 },
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      const result = await uploadBaselinesForDefinition(
        'http://localhost:19001',
        'inst-1',
        '/project/definitions/test.yaml',
        definition,
      );

      // Only login-page matches, dashboard and unused do not
      expect(result).toBe(1);
      expect(global.fetch).toHaveBeenCalledTimes(1);

      consoleSpy.mockRestore();
    });
  });
});
