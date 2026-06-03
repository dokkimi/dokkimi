jest.mock('@dokkimi/service-manager');
jest.mock('@dokkimi/config', () => ({
  loadConfig: jest.fn(),
  buildServiceUrl: jest.fn(),
}));
jest.mock('../lib/cli-utils', () => {
  const actual = jest.requireActual('../lib/cli-utils');
  return {
    ...actual,
    fetchJson: jest.fn(),
  };
});

import { getServiceStatus } from '@dokkimi/service-manager';
import { fetchJson } from '../lib/cli-utils';
import { loadConfig, buildServiceUrl } from '@dokkimi/config';
import { status } from './status';

const mockServiceStatus = getServiceStatus as jest.Mock;
const mockLoadConfig = loadConfig as jest.Mock;
const mockFetchJson = fetchJson as jest.Mock;
const mockBuildUrl = buildServiceUrl as jest.Mock;

let consoleSpy: jest.SpyInstance;
let exitSpy: jest.SpyInstance;

const MOCK_CONFIG = {
  services: { controlTower: { host: 'localhost', port: 19001 } },
};

beforeEach(() => {
  consoleSpy = jest.spyOn(console, 'log').mockImplementation();
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });
  jest.clearAllMocks();
  consoleSpy = jest.spyOn(console, 'log').mockImplementation();
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });
  mockLoadConfig.mockReturnValue(MOCK_CONFIG);
  mockBuildUrl.mockReturnValue('http://localhost:19001');
});

afterEach(() => {
  consoleSpy.mockRestore();
  exitSpy.mockRestore();
});

describe('status', () => {
  it('shows help and exits 0 with --help', async () => {
    await expect(status(['--help'])).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Usage: dokkimi status'),
    );
  });

  it('shows service uptime when healthy', async () => {
    const startedAt = new Date(Date.now() - 3600 * 1000).toISOString();
    mockServiceStatus.mockResolvedValue({ healthy: true, startedAt });
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/health')) {
        return Promise.resolve({
          status: 'ok',
          uptime: 3600,
          checks: {
            database: { status: 'healthy' },
            prisma: { status: 'healthy' },
          },
        });
      }
      if (url.includes('/namespaces/instances')) {
        return Promise.resolve([]);
      }
      return Promise.resolve(null);
    });

    await status([]);

    const allLogs = consoleSpy.mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allLogs).toContain('Dokkimi is running');
    expect(allLogs).toContain('Uptime:');
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('shows "not running" and exits 0 when service unreachable', async () => {
    mockServiceStatus.mockResolvedValue({ healthy: false });

    await expect(status([])).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(0);
    const allLogs = consoleSpy.mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allLogs).toContain('Dokkimi is not running');
  });

  it('lists active instances', async () => {
    mockServiceStatus.mockResolvedValue({
      healthy: true,
      startedAt: new Date().toISOString(),
    });
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/health')) {
        return Promise.resolve({
          status: 'ok',
          uptime: 100,
          checks: {
            database: { status: 'healthy' },
            prisma: { status: 'healthy' },
          },
        });
      }
      if (url.includes('/namespaces/instances')) {
        return Promise.resolve([
          {
            id: 'inst-1',
            definition: { id: 'd1', name: 'my-test' },
            status: 'RUNNING',
            runNumber: 1,
            createdAt: new Date(Date.now() - 60000).toISOString(),
          },
          {
            id: 'inst-2',
            definition: { id: 'd2', name: 'another-test' },
            status: 'STARTING',
            runNumber: 2,
            createdAt: new Date(Date.now() - 30000).toISOString(),
          },
        ]);
      }
      return Promise.resolve(null);
    });

    await status([]);

    const allLogs = consoleSpy.mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allLogs).toContain('Active instances:');
    expect(allLogs).toContain('my-test');
    expect(allLogs).toContain('another-test');
  });

  it('lists stopped instances count', async () => {
    mockServiceStatus.mockResolvedValue({
      healthy: true,
      startedAt: new Date().toISOString(),
    });
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/health')) {
        return Promise.resolve({
          status: 'ok',
          uptime: 100,
          checks: {
            database: { status: 'healthy' },
            prisma: { status: 'healthy' },
          },
        });
      }
      if (url.includes('/namespaces/instances')) {
        return Promise.resolve([
          {
            id: 'inst-1',
            definition: { id: 'd1', name: 'running-test' },
            status: 'RUNNING',
            runNumber: 1,
            createdAt: new Date().toISOString(),
          },
          {
            id: 'inst-2',
            definition: { id: 'd2', name: 'old-test' },
            status: 'STOPPED',
            runNumber: 2,
            createdAt: new Date().toISOString(),
          },
          {
            id: 'inst-3',
            definition: { id: 'd3', name: 'failed-test' },
            status: 'FAILED',
            runNumber: 3,
            createdAt: new Date().toISOString(),
          },
        ]);
      }
      return Promise.resolve(null);
    });

    await status([]);

    const allLogs = consoleSpy.mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allLogs).toContain('Active instances:');
    expect(allLogs).toContain('running-test');
    expect(allLogs).toContain('2 stopped instances');
  });

  it('handles no instances', async () => {
    mockServiceStatus.mockResolvedValue({
      healthy: true,
      startedAt: new Date().toISOString(),
    });
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/health')) {
        return Promise.resolve({
          status: 'ok',
          uptime: 100,
          checks: {
            database: { status: 'healthy' },
            prisma: { status: 'healthy' },
          },
        });
      }
      if (url.includes('/namespaces/instances')) {
        return Promise.resolve([]);
      }
      return Promise.resolve(null);
    });

    await status([]);

    const allLogs = consoleSpy.mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allLogs).toContain('No active instances.');
    expect(allLogs).not.toContain('stopped');
  });

  it('handles null instances response', async () => {
    mockServiceStatus.mockResolvedValue({
      healthy: true,
      startedAt: new Date().toISOString(),
    });
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/health')) {
        return Promise.resolve({
          status: 'ok',
          uptime: 100,
          checks: {
            database: { status: 'healthy' },
            prisma: { status: 'healthy' },
          },
        });
      }
      if (url.includes('/namespaces/instances')) {
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });

    await status([]);

    const allLogs = consoleSpy.mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allLogs).toContain('No active instances.');
  });
});
