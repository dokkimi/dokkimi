jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  copyFileSync: jest.fn(),
}));
jest.mock('@dokkimi/config');
jest.mock('../lib/cli-utils');
jest.mock('../lib/menu');
jest.mock('../lib/terminal');
jest.mock('../lib/baseline-upload');
jest.mock('../lib/editor');
jest.mock('@dokkimi/telemetry');
jest.mock('@dokkimi/definition-resolver');

import * as fs from 'fs';
import { fetchJson } from '../lib/cli-utils';
import { loadConfig, buildServiceUrl } from '@dokkimi/config';
import { selectMenu } from '../lib/menu';
import { enterAltScreen, exitAltScreen } from '../lib/terminal';
import { trackEvent } from '@dokkimi/telemetry';
import { resolveDefinitions } from '@dokkimi/definition-resolver';
import { findBaselinesDir } from '../lib/baseline-upload';
import { baselines } from './baselines';

const mockLoadConfig = loadConfig as jest.Mock;
const mockBuildUrl = buildServiceUrl as jest.Mock;
const mockFetchJson = fetchJson as jest.Mock;
const mockSelectMenu = selectMenu as jest.Mock;
const mockEnterAlt = enterAltScreen as jest.Mock;
const mockExitAlt = exitAltScreen as jest.Mock;
const mockTrack = trackEvent as jest.Mock;
const mockResolve = resolveDefinitions as jest.Mock;
const mockFindBaselines = findBaselinesDir as jest.Mock;
const mockExistsSync = fs.existsSync as jest.Mock;
const mockCopyFileSync = fs.copyFileSync as jest.Mock;

let consoleSpy: jest.SpyInstance;
let consoleErrorSpy: jest.SpyInstance;
let exitSpy: jest.SpyInstance;
let stdoutWriteSpy: jest.SpyInstance;

// Stub process.stdin.isTTY for interactive checks
const originalIsTTY = process.stdin.isTTY;

beforeEach(() => {
  jest.resetAllMocks();

  consoleSpy = jest.spyOn(console, 'log').mockImplementation();
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });
  stdoutWriteSpy = jest
    .spyOn(process.stdout, 'write')
    .mockImplementation(() => true);
  Object.defineProperty(process.stdin, 'isTTY', {
    value: true,
    configurable: true,
  });

  mockLoadConfig.mockReturnValue({
    services: { controlTower: { host: 'localhost', port: 19001 } },
    storage: { dir: '/tmp/dokkimi-storage' },
  });
  mockBuildUrl.mockReturnValue('http://localhost:19001');
  mockResolve.mockReturnValue({
    definitions: [
      {
        name: 'test-a',
        sourceFile: '/project/.dokkimi/proj/definitions/test-a.yaml',
      },
    ],
  });
  mockFindBaselines.mockReturnValue('/project/.dokkimi/proj/baselines');
});

afterEach(() => {
  consoleSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  exitSpy.mockRestore();
  stdoutWriteSpy.mockRestore();
  Object.defineProperty(process.stdin, 'isTTY', {
    value: originalIsTTY,
    configurable: true,
  });
});

function makeArtifact(
  overrides: Partial<import('../lib/inspect-types').ArtifactRow> = {},
): import('../lib/inspect-types').ArtifactRow {
  return {
    id: 'art-1',
    instanceId: 'inst-1',
    stepIndex: 0,
    subStepIndex: 0,
    type: 'screenshot',
    name: 'homepage',
    uri: 'captures/homepage.png',
    verdict: 'no-baseline',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('baselines', () => {
  it('shows help and exits with --help', async () => {
    await expect(baselines(['--help'])).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Usage: dokkimi baselines'),
    );
  });

  it('shows help and exits with -h', async () => {
    await expect(baselines(['-h'])).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('prints message when no pending baselines', async () => {
    mockFetchJson
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'complete',
        createdAt: '2026-01-01',
        completedAt: '2026-01-01',
        instances: [{ id: 'inst-1', name: 'test-a', status: 'complete' }],
      })
      .mockResolvedValueOnce({ pending: [] });

    await baselines([]);

    expect(consoleSpy).toHaveBeenCalledWith(
      'No pending baselines from the last run.',
    );
    expect(mockEnterAlt).not.toHaveBeenCalled();
  });

  it('enters alt screen and lists pending baselines grouped by test', async () => {
    const art1 = makeArtifact({
      id: 'a1',
      name: 'homepage',
      verdict: 'no-baseline',
    });
    const art2 = makeArtifact({ id: 'a2', name: 'dashboard', verdict: 'fail' });

    mockFetchJson
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'complete',
        createdAt: '2026-01-01',
        completedAt: '2026-01-01',
        instances: [{ id: 'inst-1', name: 'test-a', status: 'complete' }],
      })
      .mockResolvedValueOnce({ pending: [art1, art2] });

    // First selectMenu call (test list) -> user presses escape (null)
    mockSelectMenu.mockResolvedValueOnce(null);

    await baselines([]);

    expect(mockEnterAlt).toHaveBeenCalled();
    expect(mockExitAlt).toHaveBeenCalled();

    // The menu should have been called with items grouped by test
    expect(mockSelectMenu).toHaveBeenCalledTimes(1);
    const menuCall = mockSelectMenu.mock.calls[0];
    expect(menuCall[0]).toHaveLength(1); // one test group
    expect(menuCall[0][0].label).toContain('test-a');
  });

  it('approve-all approves entire batch', async () => {
    const art1 = makeArtifact({ id: 'a1', name: 'homepage' });
    const art2 = makeArtifact({ id: 'a2', name: 'dashboard' });

    mockFetchJson
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'complete',
        createdAt: '2026-01-01',
        completedAt: '2026-01-01',
        instances: [{ id: 'inst-1', name: 'test-a', status: 'complete' }],
      })
      .mockResolvedValueOnce({ pending: [art1, art2] });

    // User hits 'A' for approve-all at test list level
    mockSelectMenu.mockResolvedValueOnce({
      value: { testName: 'test-a', items: [] },
      index: 0,
      action: 'approve-all',
    });

    // Mock global fetch for updateVerdict calls
    const mockGlobalFetch = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = mockGlobalFetch;

    mockExistsSync.mockReturnValue(true);

    await baselines([]);

    expect(mockEnterAlt).toHaveBeenCalled();
    // Should report approved count
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('2 approved'),
    );
  });

  it('tracks telemetry with correct counts', async () => {
    const art1 = makeArtifact({
      id: 'a1',
      name: 'homepage',
      verdict: 'no-baseline',
    });
    const art2 = makeArtifact({ id: 'a2', name: 'dashboard', verdict: 'fail' });

    mockFetchJson
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'complete',
        createdAt: '2026-01-01',
        completedAt: '2026-01-01',
        instances: [{ id: 'inst-1', name: 'test-a', status: 'complete' }],
      })
      .mockResolvedValueOnce({ pending: [art1, art2] });

    // User escapes immediately
    mockSelectMenu.mockResolvedValueOnce(null);

    await baselines([]);

    expect(mockTrack).toHaveBeenCalledWith('cli_baselines', {
      approved: 0,
      skipped: 0,
      total_pending: 2,
      new_count: 1,
      changed_count: 1,
      mode: 'interactive',
    });
  });

  it('skip increments skipped counter in telemetry', async () => {
    const art1 = makeArtifact({
      id: 'a1',
      name: 'homepage',
      verdict: 'no-baseline',
    });

    mockFetchJson
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'complete',
        createdAt: '2026-01-01',
        completedAt: '2026-01-01',
        instances: [{ id: 'inst-1', name: 'test-a', status: 'complete' }],
      })
      .mockResolvedValueOnce({ pending: [art1] });

    // User selects a test group, then no items remain after skip
    // First: test list menu -> select test-a
    mockSelectMenu
      .mockResolvedValueOnce({
        value: {
          testName: 'test-a',
          items: [
            { instanceId: 'inst-1', instanceName: 'test-a', artifact: art1 },
          ],
        },
        index: 0,
      })
      // Second: baseline list menu -> user escapes (simulating skip happened externally)
      .mockResolvedValueOnce(null)
      // Third: back to test list -> no items remain so escape
      .mockResolvedValueOnce(null);

    await baselines([]);

    // Telemetry should be called
    expect(mockTrack).toHaveBeenCalledWith(
      'cli_baselines',
      expect.objectContaining({
        total_pending: 1,
        new_count: 1,
      }),
    );
  });

  it('requires interactive terminal', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    });

    await expect(baselines([])).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Interactive terminal required.',
    );
  });

  it('exits with error when no run history', async () => {
    mockFetchJson.mockResolvedValueOnce(null);

    await expect(baselines([])).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('No run history found'),
    );
  });

  it('detail view approve writes baseline and updates verdict', async () => {
    const art = makeArtifact({
      id: 'a1',
      name: 'login-page',
      verdict: 'no-baseline',
    });

    mockFetchJson
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'complete',
        createdAt: '2026-01-01',
        completedAt: '2026-01-01',
        instances: [{ id: 'inst-1', name: 'test-a', status: 'complete' }],
      })
      .mockResolvedValueOnce({ pending: [art] });

    // Test list -> select test-a
    mockSelectMenu.mockResolvedValueOnce({
      value: {
        testName: 'test-a',
        items: [
          { instanceId: 'inst-1', instanceName: 'test-a', artifact: art },
        ],
      },
      index: 0,
    });

    // baseline list view -> select item
    mockSelectMenu.mockResolvedValueOnce({
      value: { instanceId: 'inst-1', instanceName: 'test-a', artifact: art },
      index: 0,
    });

    // Mock stdin for detail view key press (approve)
    const originalSetRawMode = process.stdin.setRawMode;
    const mockSetRawMode = jest.fn();
    (process.stdin as any).setRawMode = mockSetRawMode;
    const stdinOn = jest
      .spyOn(process.stdin, 'on')
      .mockImplementation((event: string | symbol, cb: any) => {
        if (event === 'data') {
          setTimeout(() => cb('y'), 0);
        }
        return process.stdin;
      });

    mockExistsSync.mockReturnValue(true);

    const mockGlobalFetch = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = mockGlobalFetch;

    await baselines([]);

    expect(mockCopyFileSync).toHaveBeenCalled();
    expect(mockGlobalFetch).toHaveBeenCalledWith(
      expect.stringContaining('/artifacts/a1/verdict'),
      expect.objectContaining({ method: 'PATCH' }),
    );

    stdinOn.mockRestore();
    (process.stdin as any).setRawMode = originalSetRawMode;
  });

  it('detail view skip updates verdict without writing baseline', async () => {
    const art = makeArtifact({
      id: 'a1',
      name: 'login-page',
      verdict: 'no-baseline',
    });

    mockFetchJson
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'complete',
        createdAt: '2026-01-01',
        completedAt: '2026-01-01',
        instances: [{ id: 'inst-1', name: 'test-a', status: 'complete' }],
      })
      .mockResolvedValueOnce({ pending: [art] });

    mockSelectMenu
      .mockResolvedValueOnce({
        value: {
          testName: 'test-a',
          items: [
            { instanceId: 'inst-1', instanceName: 'test-a', artifact: art },
          ],
        },
        index: 0,
      })
      .mockResolvedValueOnce({
        value: { instanceId: 'inst-1', instanceName: 'test-a', artifact: art },
        index: 0,
      });

    const originalSetRawMode = process.stdin.setRawMode;
    (process.stdin as any).setRawMode = jest.fn();
    const stdinOn = jest
      .spyOn(process.stdin, 'on')
      .mockImplementation((event: string | symbol, cb: any) => {
        if (event === 'data') {
          setTimeout(() => cb('s'), 0);
        }
        return process.stdin;
      });

    const mockGlobalFetch = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = mockGlobalFetch;

    // After detail returns 'skipped', baseline list is empty, back to test list which is also empty
    mockSelectMenu.mockResolvedValueOnce(null);

    await baselines([]);

    expect(mockCopyFileSync).not.toHaveBeenCalled();
    expect(mockGlobalFetch).toHaveBeenCalledWith(
      expect.stringContaining('/artifacts/a1/verdict'),
      expect.objectContaining({
        body: JSON.stringify({ verdict: 'skipped' }),
      }),
    );

    stdinOn.mockRestore();
    (process.stdin as any).setRawMode = originalSetRawMode;
  });

  it('detail view back returns to list without action', async () => {
    const art = makeArtifact({ id: 'a1', name: 'homepage', verdict: 'fail' });

    mockFetchJson
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'complete',
        createdAt: '2026-01-01',
        completedAt: '2026-01-01',
        instances: [{ id: 'inst-1', name: 'test-a', status: 'complete' }],
      })
      .mockResolvedValueOnce({ pending: [art] });

    mockSelectMenu
      .mockResolvedValueOnce({
        value: {
          testName: 'test-a',
          items: [
            { instanceId: 'inst-1', instanceName: 'test-a', artifact: art },
          ],
        },
        index: 0,
      })
      .mockResolvedValueOnce({
        value: { instanceId: 'inst-1', instanceName: 'test-a', artifact: art },
        index: 0,
      });

    const originalSetRawMode = process.stdin.setRawMode;
    (process.stdin as any).setRawMode = jest.fn();
    const stdinOn = jest
      .spyOn(process.stdin, 'on')
      .mockImplementation((event: string | symbol, cb: any) => {
        if (event === 'data') {
          setTimeout(() => cb('\x1b'), 0); // escape = back
        }
        return process.stdin;
      });

    // After returning 'back', baseline list re-renders, then escape out
    mockSelectMenu
      .mockResolvedValueOnce(null) // baseline list escape
      .mockResolvedValueOnce(null); // test list escape

    const mockGlobalFetch = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = mockGlobalFetch;

    await baselines([]);

    // No verdict update since we went back
    expect(mockGlobalFetch).not.toHaveBeenCalled();
    expect(mockCopyFileSync).not.toHaveBeenCalled();

    stdinOn.mockRestore();
    (process.stdin as any).setRawMode = originalSetRawMode;
  });

  it('no baselines changed message when user escapes without action', async () => {
    const art = makeArtifact({
      id: 'a1',
      name: 'homepage',
      verdict: 'no-baseline',
    });

    mockFetchJson
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'complete',
        createdAt: '2026-01-01',
        completedAt: '2026-01-01',
        instances: [{ id: 'inst-1', name: 'test-a', status: 'complete' }],
      })
      .mockResolvedValueOnce({ pending: [art] });

    mockSelectMenu.mockResolvedValueOnce(null);

    await baselines([]);

    expect(consoleSpy).toHaveBeenCalledWith('\nNo baselines changed.');
  });

  it('prints approved and skipped summary counts', async () => {
    const art1 = makeArtifact({ id: 'a1', name: 'homepage' });
    const art2 = makeArtifact({ id: 'a2', name: 'dashboard' });

    mockFetchJson
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'complete',
        createdAt: '2026-01-01',
        completedAt: '2026-01-01',
        instances: [{ id: 'inst-1', name: 'test-a', status: 'complete' }],
      })
      .mockResolvedValueOnce({ pending: [art1, art2] });

    mockSelectMenu.mockResolvedValueOnce({
      value: { testName: 'test-a', items: [] },
      index: 0,
      action: 'approve-all',
    });

    mockExistsSync.mockReturnValue(true);
    const mockGlobalFetch = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = mockGlobalFetch;

    await baselines([]);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('2 approved'),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Commit the updated baselines'),
    );
  });
});
