jest.mock('@dokkimi/definition-resolver', () => ({
  resolveDefinitions: jest.fn(),
}));
jest.mock('@dokkimi/config', () => ({
  loadConfig: jest.fn(),
  buildServiceUrl: jest.fn(),
}));
jest.mock('../lib/cli-utils', () => ({
  fetchJson: jest.fn(),
}));
jest.mock('../lib/inspect-run', () => ({
  inspectRun: jest.fn(),
}));

import { inspect } from './inspect';
import { resolveDefinitions } from '@dokkimi/definition-resolver';
import { fetchJson } from '../lib/cli-utils';
import { loadConfig, buildServiceUrl } from '@dokkimi/config';
import { inspectRun } from '../lib/inspect-run';

const mockResolveDefinitions = resolveDefinitions as jest.Mock;
const mockFetchJson = fetchJson as jest.Mock;
const mockLoadConfig = loadConfig as jest.Mock;
const mockBuildServiceUrl = buildServiceUrl as jest.Mock;
const mockInspectRun = inspectRun as jest.Mock;

const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
  throw new Error('process.exit');
});

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadConfig.mockReturnValue({
    services: { controlTower: { host: 'localhost', port: 19001 } },
    storage: { dir: '/tmp/storage' },
  });
  mockBuildServiceUrl.mockReturnValue('http://localhost:19001');
  mockInspectRun.mockResolvedValue(undefined);
});

describe('inspect', () => {
  it('shows help and exits on --help flag', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    await expect(inspect(['--help'])).rejects.toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(0);
    expect(logSpy.mock.calls[0][0]).toContain('Usage: dokkimi inspect');
    logSpy.mockRestore();
  });

  it('shows help and exits on -h flag', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    await expect(inspect(['-h'])).rejects.toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(0);
    logSpy.mockRestore();
  });

  it('fetches latest run and calls inspectRun', async () => {
    const instances = [
      { id: 'inst-1', name: 'test-a', status: 'PASSED' },
      { id: 'inst-2', name: 'test-b', status: 'FAILED' },
    ];
    mockFetchJson.mockResolvedValue({ runId: 'run-1', instances });

    await inspect([]);

    expect(mockFetchJson).toHaveBeenCalledWith(
      'http://localhost:19001/runs/latest',
    );
    expect(mockInspectRun).toHaveBeenCalledWith(
      'http://localhost:19001',
      'run-1',
      instances,
      '/tmp/storage',
    );
  });

  it('handles no latest run', async () => {
    mockFetchJson.mockResolvedValue(null);
    const logSpy = jest.spyOn(console, 'log').mockImplementation();

    await inspect([]);

    expect(logSpy).toHaveBeenCalledWith(
      'No run history found. Run `dokkimi run` first.',
    );
    expect(mockInspectRun).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('passes target filter to inspectRun', async () => {
    const instances = [
      { id: 'inst-1', name: 'auth', status: 'PASSED' },
      { id: 'inst-2', name: 'billing', status: 'PASSED' },
    ];
    mockFetchJson.mockResolvedValue({ runId: 'run-2', instances });
    mockResolveDefinitions.mockReturnValue({
      definitions: [{ name: 'auth' }],
      errors: [],
    });

    await inspect(['auth']);

    expect(mockResolveDefinitions).toHaveBeenCalledWith('auth');
    expect(mockInspectRun).toHaveBeenCalledWith(
      'http://localhost:19001',
      'run-2',
      [{ id: 'inst-1', name: 'auth', status: 'PASSED' }],
      '/tmp/storage',
    );
  });

  it('shows message when target filter matches no instances', async () => {
    const instances = [{ id: 'inst-1', name: 'auth', status: 'PASSED' }];
    mockFetchJson.mockResolvedValue({ runId: 'run-3', instances });
    mockResolveDefinitions.mockReturnValue({
      definitions: [{ name: 'nonexistent' }],
      errors: [],
    });
    const logSpy = jest.spyOn(console, 'log').mockImplementation();

    await inspect(['nonexistent']);

    expect(logSpy).toHaveBeenCalledWith(
      'No run history found for "nonexistent".',
    );
    expect(mockInspectRun).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
