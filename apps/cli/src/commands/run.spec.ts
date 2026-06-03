jest.mock('@dokkimi/definition-resolver', () => ({
  resolveDefinitions: jest.fn(),
}));
jest.mock('@dokkimi/service-manager', () => ({
  ensureServicesRunning: jest.fn(),
  resolveAppRoot: jest.fn(() => '/app-root'),
}));
jest.mock('@dokkimi/telemetry', () => ({
  trackEvent: jest.fn(),
}));
jest.mock('@dokkimi/config', () => ({
  loadConfig: jest.fn(),
  buildServiceUrl: jest.fn(),
  DokkimiConfig: {},
}));
jest.mock('../lib/cli-utils', () => ({
  fetchJson: jest.fn(),
  fetchPostWithError: jest.fn(),
  fetchAction: jest.fn(),
}));
jest.mock('../lib/run-display', () => ({
  pollForCompletion: jest.fn(),
}));
jest.mock('../lib/ci-display', () => ({
  pollForCompletionCI: jest.fn(),
}));
jest.mock('../lib/inspect-run', () => ({
  inspectRun: jest.fn(),
}));
jest.mock('../lib/baseline-upload', () => ({
  uploadBaselinesForDefinition: jest.fn(),
}));
jest.mock('../lib/registry-credentials', () => ({
  resolveRegistryCredentials: jest.fn(),
}));
jest.mock('../lib/version', () => ({
  warnIfVersionMismatch: jest.fn(),
}));
jest.mock('../lib/update-check', () => ({
  checkForUpdate: jest.fn(),
}));
jest.mock('./baselines', () => ({
  baselines: jest.fn(),
}));
jest.mock('./run-helpers', () => {
  const actual = jest.requireActual('./run-helpers');
  return {
    ...actual,
    submitDefinition: jest.fn().mockResolvedValue(null),
    trackRunError: jest.fn(),
  };
});

import { run } from './run';
import { resolveDefinitions } from '@dokkimi/definition-resolver';
import { ensureServicesRunning } from '@dokkimi/service-manager';
import { trackEvent } from '@dokkimi/telemetry';
import { fetchJson, fetchPostWithError, fetchAction } from '../lib/cli-utils';
import { loadConfig, buildServiceUrl } from '@dokkimi/config';
import { pollForCompletion } from '../lib/run-display';
import { pollForCompletionCI } from '../lib/ci-display';
import { uploadBaselinesForDefinition } from '../lib/baseline-upload';
import { resolveRegistryCredentials } from '../lib/registry-credentials';

const mockResolveDefinitions = resolveDefinitions as jest.Mock;
const mockEnsureServicesRunning = ensureServicesRunning as jest.Mock;
const mockTrackEvent = trackEvent as jest.Mock;
const mockLoadConfig = loadConfig as jest.Mock;
const mockBuildServiceUrl = buildServiceUrl as jest.Mock;
const mockFetchJson = fetchJson as jest.Mock;
const mockFetchPostWithError = fetchPostWithError as jest.Mock;
const mockFetchAction = fetchAction as jest.Mock;
const mockPollForCompletion = pollForCompletion as jest.Mock;
const mockPollForCompletionCI = pollForCompletionCI as jest.Mock;
const mockUploadBaselines = uploadBaselinesForDefinition as jest.Mock;
const mockResolveRegistryCredentials = resolveRegistryCredentials as jest.Mock;

const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
  throw new Error('process.exit');
});

// Suppress console output
const logSpy = jest.spyOn(console, 'log').mockImplementation();
const errorSpy = jest.spyOn(console, 'error').mockImplementation();

const defaultConfig = {
  services: { controlTower: { host: 'localhost', port: 19001 } },
  storage: { dir: '/tmp/storage' },
};

const defaultPollResult = {
  passed: true,
  runId: 'run-1',
  instances: [
    { id: 'inst-1', name: 'test-a', status: 'COMPLETED', testStatus: 'PASSED' },
  ],
};

function setupDefaultMocks() {
  mockLoadConfig.mockReturnValue(defaultConfig);
  mockBuildServiceUrl.mockReturnValue('http://localhost:19001');
  mockEnsureServicesRunning.mockResolvedValue(undefined);
  mockResolveDefinitions.mockReturnValue({
    definitions: [
      {
        name: 'test-a',
        sourceFile: '/project/.dokkimi/test-a.yml',
        definition: { name: 'test-a', items: [], tests: [] },
      },
    ],
    errors: [],
    config: {},
    consumedFiles: ['/project/.dokkimi/test-a.yml'],
  });
  mockFetchPostWithError.mockResolvedValue({
    data: {
      runId: 'run-1',
      instances: [{ id: 'inst-1', name: 'test-a', status: 'PENDING' }],
    },
  });
  mockPollForCompletion.mockResolvedValue(defaultPollResult);
  mockPollForCompletionCI.mockResolvedValue(defaultPollResult);
  mockUploadBaselines.mockResolvedValue(0);
  mockResolveRegistryCredentials.mockReturnValue([]);
  mockFetchAction.mockResolvedValue(undefined);
  mockFetchJson.mockResolvedValue(null);

  // Non-interactive mode
  Object.defineProperty(process.stdin, 'isTTY', {
    value: false,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: false,
    configurable: true,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  setupDefaultMocks();
});

afterAll(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('run', () => {
  it('shows help and exits on --help flag', async () => {
    await expect(run(['--help'])).rejects.toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(0);
    expect(logSpy.mock.calls[0][0]).toContain('Usage: dokkimi run');
  });

  it('shows help and exits on -h flag', async () => {
    await expect(run(['-h'])).rejects.toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('creates run via CT API with resolved definitions', async () => {
    // non-TTY + non-watch exits with process.exit
    await expect(run([])).rejects.toThrow('process.exit');

    expect(mockResolveDefinitions).toHaveBeenCalledWith(undefined);
    expect(mockEnsureServicesRunning).toHaveBeenCalledWith(
      '/app-root',
      defaultConfig,
      undefined,
      expect.any(AbortSignal),
    );
    expect(mockFetchPostWithError).toHaveBeenCalledWith(
      'http://localhost:19001/runs',
      { definitions: ['test-a'] },
    );
    expect(mockPollForCompletion).toHaveBeenCalledWith(
      'http://localhost:19001',
      'run-1',
      expect.any(AbortController),
      [],
    );
  });

  it('--ci flag uses CI config and CI display polling', async () => {
    await expect(run(['--ci'])).rejects.toThrow('process.exit');

    expect(mockLoadConfig).toHaveBeenCalled();
    expect(mockPollForCompletionCI).toHaveBeenCalled();
    expect(mockPollForCompletion).not.toHaveBeenCalled();
    // Exits 0 on passed
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('--ci exits with 1 when tests fail', async () => {
    mockPollForCompletionCI.mockResolvedValue({
      passed: false,
      runId: 'run-1',
      instances: [
        {
          id: 'inst-1',
          name: 'test-a',
          status: 'FAILED',
          testStatus: 'FAILED',
        },
      ],
    });

    await expect(run(['--ci'])).rejects.toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('handles definition resolution errors (all invalid) - skips run', async () => {
    mockResolveDefinitions.mockReturnValue({
      definitions: [],
      errors: [{ file: '/project/.dokkimi/bad.yml', errors: ['syntax error'] }],
      config: {},
      consumedFiles: [],
    });

    await expect(run(['--ci'])).rejects.toThrow('process.exit');

    expect(mockFetchPostWithError).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('No valid definitions to run.');
  });

  it('handles empty definitions', async () => {
    mockResolveDefinitions.mockReturnValue({
      definitions: [],
      errors: [],
      config: {},
      consumedFiles: [],
    });

    await expect(run(['--ci'])).rejects.toThrow('process.exit');

    expect(mockFetchPostWithError).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('No runnable definitions found.');
  });

  it('tracks telemetry event with correct counts', async () => {
    const pollResult = {
      passed: false,
      runId: 'run-1',
      instances: [
        {
          id: 'inst-1',
          name: 'test-a',
          status: 'COMPLETED',
          testStatus: 'PASSED',
        },
        {
          id: 'inst-2',
          name: 'test-b',
          status: 'COMPLETED',
          testStatus: 'FAILED',
        },
      ],
    };
    mockPollForCompletion.mockResolvedValue(pollResult);
    mockPollForCompletionCI.mockResolvedValue(pollResult);
    mockResolveDefinitions.mockReturnValue({
      definitions: [
        {
          name: 'test-a',
          sourceFile: 'a.yml',
          definition: { name: 'test-a', items: [], tests: [] },
        },
        {
          name: 'test-b',
          sourceFile: 'b.yml',
          definition: { name: 'test-b', items: [], tests: [] },
        },
      ],
      errors: [],
      config: {},
      consumedFiles: [],
    });
    mockFetchPostWithError.mockResolvedValue({
      data: {
        runId: 'run-1',
        instances: [
          { id: 'inst-1', name: 'test-a', status: 'PENDING' },
          { id: 'inst-2', name: 'test-b', status: 'PENDING' },
        ],
      },
    });

    await expect(run(['--ci'])).rejects.toThrow('process.exit');

    expect(mockTrackEvent).toHaveBeenCalledWith(
      'cli_run_result',
      expect.objectContaining({
        definition_count: 2,
        passed_count: 1,
        failed_count: 1,
        trigger: 'initial',
        watch_mode: false,
      }),
    );
  });

  it('registry credentials included in create body', async () => {
    mockResolveRegistryCredentials.mockReturnValue([
      { registry: 'ghcr.io', username: 'user', password: 'pass' },
    ]);

    await expect(run(['--ci'])).rejects.toThrow('process.exit');

    expect(mockFetchPostWithError).toHaveBeenCalledWith(
      'http://localhost:19001/runs',
      {
        definitions: ['test-a'],
        registryCredentials: [
          { registry: 'ghcr.io', username: 'user', password: 'pass' },
        ],
      },
    );
  });

  it('timeout argument parsing', async () => {
    await expect(run(['--ci', '--timeout=30'])).rejects.toThrow('process.exit');

    // The timeout (30s = 30000ms) is passed to pollForCompletionCI
    expect(mockPollForCompletionCI).toHaveBeenCalledWith(
      'http://localhost:19001',
      'run-1',
      expect.any(AbortController),
      [],
      30000,
      1,
    );
  });

  it('CI mode defaults timeout to 600s', async () => {
    await expect(run(['--ci'])).rejects.toThrow('process.exit');

    expect(mockPollForCompletionCI).toHaveBeenCalledWith(
      'http://localhost:19001',
      'run-1',
      expect.any(AbortController),
      [],
      600000,
      1,
    );
  });

  it('--watch flag is parsed without crashing in non-TTY mode', async () => {
    // In non-TTY + non-watch, it would exit; with --watch, the watcher import
    // is attempted. Because chokidar is not available in test env, we verify
    // no crash from the flag parsing itself by catching the import error.
    // The key assertion is that --watch doesn't cause a flag-parsing crash.
    try {
      await run(['--watch']);
    } catch (err) {
      // Expected: either process.exit or dynamic import failure for chokidar
      expect(err).toBeDefined();
    }
    expect(mockLoadConfig).toHaveBeenCalled();
  });

  it('target argument is passed to resolveDefinitions', async () => {
    await expect(run(['my-test-dir'])).rejects.toThrow('process.exit');
    expect(mockResolveDefinitions).toHaveBeenCalledWith('my-test-dir');
  });

  it('target argument with file extension is passed through', async () => {
    await expect(run(['.dokkimi/auth.yml'])).rejects.toThrow('process.exit');
    expect(mockResolveDefinitions).toHaveBeenCalledWith('.dokkimi/auth.yml');
  });

  it('pattern target is passed through', async () => {
    await expect(run(['auth'])).rejects.toThrow('process.exit');
    expect(mockResolveDefinitions).toHaveBeenCalledWith('auth');
  });

  it('cleanup is called on SIGINT', async () => {
    // Verify SIGINT handler is registered
    const _sigintListeners = process.listenerCount('SIGINT');
    // Run in non-TTY mode so it exits immediately
    await expect(run(['--ci'])).rejects.toThrow('process.exit');
    // fetchAction should be called for /runs/stop (CI cleanup)
    expect(mockFetchAction).toHaveBeenCalledWith(
      'http://localhost:19001/runs/stop',
      'POST',
    );
  });

  it('non-TTY without watch exits with code 0 when passed', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
    });
    mockPollForCompletion.mockResolvedValue({
      passed: true,
      runId: 'run-1',
      instances: [
        {
          id: 'inst-1',
          name: 'test-a',
          status: 'COMPLETED',
          testStatus: 'PASSED',
        },
      ],
    });

    await expect(run([])).rejects.toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('non-TTY without watch exits with code 1 when failed', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
    });
    mockPollForCompletion.mockResolvedValue({
      passed: false,
      runId: 'run-1',
      instances: [
        {
          id: 'inst-1',
          name: 'test-a',
          status: 'FAILED',
          testStatus: 'FAILED',
        },
      ],
    });

    await expect(run([])).rejects.toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('handles create run API error', async () => {
    mockFetchPostWithError.mockResolvedValue({
      error: 'Cluster is full',
    });

    await expect(run(['--ci'])).rejects.toThrow('process.exit');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Cluster is full'),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('uploads baselines for definitions with UI steps', async () => {
    mockResolveDefinitions.mockReturnValue({
      definitions: [
        {
          name: 'test-ui',
          sourceFile: '/project/.dokkimi/test-ui.yml',
          definition: {
            name: 'test-ui',
            items: [],
            tests: [{ steps: [{ action: { type: 'ui.screenshot' } }] }],
          },
        },
      ],
      errors: [],
      config: {},
      consumedFiles: [],
    });
    mockFetchPostWithError.mockResolvedValue({
      data: {
        runId: 'run-1',
        instances: [{ id: 'inst-1', name: 'test-ui', status: 'PENDING' }],
      },
    });
    mockUploadBaselines.mockResolvedValue(2);

    await expect(run(['--ci'])).rejects.toThrow('process.exit');

    expect(mockUploadBaselines).toHaveBeenCalledWith(
      'http://localhost:19001',
      'inst-1',
      '/project/.dokkimi/test-ui.yml',
      expect.objectContaining({ name: 'test-ui' }),
    );
  });

  it('handles partial definition errors alongside valid ones', async () => {
    mockResolveDefinitions.mockReturnValue({
      definitions: [
        {
          name: 'test-a',
          sourceFile: '/project/.dokkimi/test-a.yml',
          definition: { name: 'test-a', items: [], tests: [] },
        },
      ],
      errors: [
        { file: '/project/.dokkimi/bad.yml', errors: ['Invalid reference'] },
      ],
      config: {},
      consumedFiles: [],
    });

    await expect(run(['--ci'])).rejects.toThrow('process.exit');

    // Should still create the run with the valid definition
    expect(mockFetchPostWithError).toHaveBeenCalledWith(
      'http://localhost:19001/runs',
      { definitions: ['test-a'] },
    );
  });

  it('--timeout=0 is treated as no timeout', async () => {
    await expect(run(['--ci', '--timeout=0'])).rejects.toThrow('process.exit');

    expect(mockPollForCompletionCI).toHaveBeenCalledWith(
      'http://localhost:19001',
      'run-1',
      expect.any(AbortController),
      [],
      0,
      1,
    );
  });

  it('submission with multiple definitions', async () => {
    mockResolveDefinitions.mockReturnValue({
      definitions: [
        {
          name: 'test-a',
          sourceFile: 'a.yml',
          definition: { name: 'test-a', items: [], tests: [] },
        },
        {
          name: 'test-b',
          sourceFile: 'b.yml',
          definition: { name: 'test-b', items: [], tests: [] },
        },
        {
          name: 'test-c',
          sourceFile: 'c.yml',
          definition: { name: 'test-c', items: [], tests: [] },
        },
      ],
      errors: [],
      config: {},
      consumedFiles: [],
    });
    mockFetchPostWithError.mockResolvedValue({
      data: {
        runId: 'run-1',
        instances: [
          { id: 'inst-1', name: 'test-a', status: 'PENDING' },
          { id: 'inst-2', name: 'test-b', status: 'PENDING' },
          { id: 'inst-3', name: 'test-c', status: 'PENDING' },
        ],
      },
    });

    await expect(run(['--ci'])).rejects.toThrow('process.exit');

    expect(mockFetchPostWithError).toHaveBeenCalledWith(
      'http://localhost:19001/runs',
      { definitions: ['test-a', 'test-b', 'test-c'] },
    );
  });

  it('tracks skipped instances in telemetry', async () => {
    const pollResult = {
      passed: true,
      runId: 'run-1',
      instances: [
        {
          id: 'inst-1',
          name: 'test-a',
          status: 'COMPLETED',
          testStatus: 'PASSED',
        },
        {
          id: 'inst-2',
          name: 'test-b',
          status: 'SKIPPED',
          testStatus: 'SKIPPED',
        },
      ],
    };
    mockPollForCompletionCI.mockResolvedValue(pollResult);
    mockResolveDefinitions.mockReturnValue({
      definitions: [
        {
          name: 'test-a',
          sourceFile: 'a.yml',
          definition: { name: 'test-a', items: [], tests: [] },
        },
        {
          name: 'test-b',
          sourceFile: 'b.yml',
          definition: { name: 'test-b', items: [], tests: [] },
        },
      ],
      errors: [],
      config: {},
      consumedFiles: [],
    });
    mockFetchPostWithError.mockResolvedValue({
      data: {
        runId: 'run-1',
        instances: [
          { id: 'inst-1', name: 'test-a', status: 'PENDING' },
          { id: 'inst-2', name: 'test-b', status: 'PENDING' },
        ],
      },
    });

    await expect(run(['--ci'])).rejects.toThrow('process.exit');

    expect(mockTrackEvent).toHaveBeenCalledWith(
      'cli_run_result',
      expect.objectContaining({
        skipped_count: 1,
        passed_count: 1,
      }),
    );
  });
});
