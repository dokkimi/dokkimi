jest.mock('@dokkimi/config', () => ({
  loadConfig: jest.fn(() => ({
    services: { controlTower: { host: 'localhost', port: 19001 } },
  })),
  buildServiceUrl: jest.fn(() => 'http://localhost:19001'),
  DOKKIMI_DIR: '/tmp/mock-dokkimi',
}));
jest.mock('../lib/cli-utils', () => ({
  fetchJson: jest.fn(),
  fetchAction: jest.fn(),
  checkService: jest.fn(),
  prompt: jest.fn(),
  sleep: jest.fn(),
}));

jest.mock('@dokkimi/platform', () => ({
  execSilent: jest.fn(),
}));

jest.mock('../lib/formatting', () => ({
  formatDuration: jest.fn(() => '0s'),
  statusColor: jest.fn(() => '\x1b[0m'),
}));

jest.mock('../lib/terminal', () => ({
  clearLines: jest.fn(),
}));

import { fetchJson, fetchAction, checkService, prompt } from '../lib/cli-utils';
import { execSilent } from '@dokkimi/platform';
import { clean } from './clean';

const mockFetchJson = fetchJson as jest.MockedFunction<typeof fetchJson>;
const mockFetchAction = fetchAction as jest.MockedFunction<typeof fetchAction>;
const mockCheckService = checkService as jest.MockedFunction<
  typeof checkService
>;
const mockPrompt = prompt as jest.MockedFunction<typeof prompt>;
const mockExecSilent = execSilent as jest.MockedFunction<typeof execSilent>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let processExitSpy: jest.SpyInstance;
let consoleLogSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });
  consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  // execSilent returns empty by default (no namespaces found)
  mockExecSilent.mockReturnValue('');
});

afterEach(() => {
  processExitSpy.mockRestore();
  consoleLogSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('clean', () => {
  it('prints help and exits on --help', async () => {
    await expect(clean(['--help'])).rejects.toThrow('process.exit');
    expect(processExitSpy).toHaveBeenCalledWith(0);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Usage: dokkimi clean'),
    );
  });

  it('prints help and exits on -h', async () => {
    await expect(clean(['-h'])).rejects.toThrow('process.exit');
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it('stops instances via CT API (graceful path)', async () => {
    mockCheckService.mockResolvedValue({
      healthy: true,
      name: 'ct',
      url: 'http://localhost',
    });
    mockFetchJson.mockImplementation(async (url: string) => {
      if (url.includes('/runs/latest')) {
        return {
          runId: 'run-1',
          instances: [{ id: 'inst-1', name: 'test-1', status: 'RUNNING' }],
        } as any;
      }
      if (url.includes('/status')) {
        return {
          instances: [{ id: 'inst-1', name: 'test-1', status: 'STOPPED' }],
        } as any;
      }
      return null;
    });
    mockPrompt.mockResolvedValue('Y');

    await clean([]);

    expect(mockFetchAction).toHaveBeenCalledWith(
      expect.stringContaining('/runs/stop'),
      'POST',
    );
    expect(mockFetchAction).toHaveBeenCalledWith(
      expect.stringContaining('/runs/all'),
      'DELETE',
    );
  });

  it('handles no active runs', async () => {
    mockCheckService.mockResolvedValue({
      healthy: true,
      name: 'ct',
      url: 'http://localhost',
    });
    mockFetchJson.mockResolvedValue({
      runId: 'run-1',
      instances: [],
    } as any);

    await expect(clean([])).rejects.toThrow('process.exit');

    expect(processExitSpy).toHaveBeenCalledWith(0);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Nothing to clean'),
    );
  });

  it('falls back to direct Docker cleanup when CT is down', async () => {
    mockCheckService.mockResolvedValue({
      healthy: false,
      name: 'ct',
      url: 'http://localhost',
    });
    // 1. findDokkimiContainers in clean() -> container names
    // 2. findDokkimiContainers in cleanupDokkimiDockerResources -> container names
    // 3. docker rm -f dokkimi-abc123
    // 4. docker rm -f dokkimi-def456
    // 5. findDokkimiNetworks in cleanupDokkimiDockerResources -> empty
    mockExecSilent
      .mockReturnValueOnce('dokkimi-abc123\ndokkimi-def456')
      .mockReturnValueOnce('dokkimi-abc123\ndokkimi-def456')
      .mockReturnValueOnce('')
      .mockReturnValueOnce('')
      .mockReturnValue('');
    mockPrompt.mockResolvedValue('Y');

    await clean([]);

    // Should attempt docker rm -f for the containers
    expect(mockExecSilent).toHaveBeenCalledWith(
      expect.stringContaining('docker rm -f dokkimi-abc123'),
      expect.anything(),
    );
    expect(mockExecSilent).toHaveBeenCalledWith(
      expect.stringContaining('docker rm -f dokkimi-def456'),
      expect.anything(),
    );
  });

  it('direct Docker path handles no containers or networks', async () => {
    mockCheckService.mockResolvedValue({
      healthy: false,
      name: 'ct',
      url: 'http://localhost',
    });
    // findDokkimiContainers returns empty, findDokkimiNetworks returns empty
    mockExecSilent.mockReturnValue('');

    await expect(clean([])).rejects.toThrow('process.exit');

    expect(processExitSpy).toHaveBeenCalledWith(0);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Nothing to clean'),
    );
  });
});
