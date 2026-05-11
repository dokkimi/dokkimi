jest.mock('@dokkimi/platform');
jest.mock('@dokkimi/telemetry');
jest.mock('@dokkimi/service-manager');
jest.mock('@dokkimi/config', () => ({
  loadConfig: jest.fn().mockReturnValue({
    services: { controlTower: { host: 'localhost', port: 19001 } },
  }),
}));
jest.mock('../lib/cli-utils', () => {
  const actual = jest.requireActual('../lib/cli-utils');
  return { ...actual };
});
jest.mock('fs');

import {
  execSilent,
  isCommandAvailable,
  getDiskSpaceAvailable,
} from '@dokkimi/platform';
import { trackEvent } from '@dokkimi/telemetry';
import { getServiceStatus } from '@dokkimi/service-manager';
import { existsSync, readFileSync, statSync } from 'fs';
import { doctor } from './doctor';

const mockExecSilent = execSilent as jest.Mock;
const mockIsCommand = isCommandAvailable as jest.Mock;
const mockDiskSpace = getDiskSpaceAvailable as jest.Mock;
const mockTrack = trackEvent as jest.Mock;
const mockServiceStatus = getServiceStatus as jest.Mock;
const mockExistsSync = existsSync as jest.Mock;
const mockReadFileSync = readFileSync as jest.Mock;
const mockStatSync = statSync as jest.Mock;

let consoleSpy: jest.SpyInstance;
let exitSpy: jest.SpyInstance;

function setupAllPassing() {
  // Docker
  mockExecSilent.mockImplementation((cmd: string) => {
    if (cmd === 'docker info') {
      return 'ok';
    }
    if (cmd.includes('docker system info')) {
      return '8589934592';
    } // 8GB
    if (cmd.includes('kubectl cluster-info')) {
      return 'Kubernetes is running at https://127.0.0.1:6443';
    }
    if (cmd.includes('kubectl config current-context')) {
      return 'docker-desktop';
    }
    return '';
  });
  mockIsCommand.mockReturnValue(true);
  mockDiskSpace.mockReturnValue(100);
  mockServiceStatus.mockResolvedValue({ healthy: true });
  // Database: file exists with valid SQLite header and core tables
  mockExistsSync.mockReturnValue(true);
  mockStatSync.mockReturnValue({ size: 4096 });
  const header = Buffer.alloc(128 * 1024);
  header.write('SQLite format 3', 0, 'ascii');
  header.write('runs', 100, 'ascii');
  mockReadFileSync.mockReturnValue(header);
}

beforeEach(() => {
  consoleSpy = jest.spyOn(console, 'log').mockImplementation();
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });
  jest.clearAllMocks();
  // Re-apply console/exit spies after clearAllMocks
  consoleSpy = jest.spyOn(console, 'log').mockImplementation();
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });
});

afterEach(() => {
  consoleSpy.mockRestore();
  exitSpy.mockRestore();
});

describe('doctor', () => {
  it('shows help and exits 0 with --help', async () => {
    await expect(doctor(['--help'])).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Usage: dokkimi doctor'),
    );
  });

  it('all checks pass exits 0', async () => {
    setupAllPassing();

    await doctor([]);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('All checks passed'),
    );
  });

  it('Docker not installed reports failure and exits 1', async () => {
    setupAllPassing();
    // Docker fails
    mockExecSilent.mockImplementation((cmd: string) => {
      if (cmd === 'docker info') {
        throw new Error('not found');
      }
      if (cmd.includes('kubectl cluster-info')) {
        return 'Kubernetes is running at https://127.0.0.1:6443';
      }
      if (cmd.includes('kubectl config current-context')) {
        return 'docker-desktop';
      }
      return '';
    });
    mockIsCommand.mockImplementation((cmd: string) => {
      if (cmd === 'docker') {
        return false;
      }
      return true;
    });

    await expect(doctor([])).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    // Should mention Docker not installed in console output
    const allLogs = consoleSpy.mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allLogs).toContain('not installed');
  });

  it('Kubernetes not reachable reports failure and exits 1', async () => {
    setupAllPassing();
    mockExecSilent.mockImplementation((cmd: string) => {
      if (cmd === 'docker info') {
        return 'ok';
      }
      if (cmd.includes('docker system info')) {
        return '8589934592';
      }
      if (cmd.includes('kubectl cluster-info')) {
        throw new Error('unreachable');
      }
      if (cmd.includes('kubectl config current-context')) {
        return 'docker-desktop';
      }
      return '';
    });

    await expect(doctor([])).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const allLogs = consoleSpy.mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allLogs).toContain('cluster not reachable');
  });

  it('low disk space reports failure and exits 1', async () => {
    setupAllPassing();
    mockDiskSpace.mockReturnValue(2);

    await expect(doctor([])).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const allLogs = consoleSpy.mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allLogs).toContain('2 GB available');
  });

  it('database with empty file reports failure', async () => {
    setupAllPassing();
    mockStatSync.mockReturnValue({ size: 0 });

    await expect(doctor([])).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const allLogs = consoleSpy.mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allLogs).toContain('empty');
  });

  it('database with valid schema passes', async () => {
    setupAllPassing();

    await doctor([]);

    expect(exitSpy).not.toHaveBeenCalled();
    const allLogs = consoleSpy.mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allLogs).toContain('initialized');
  });

  it('tracks telemetry with per-check results', async () => {
    setupAllPassing();

    await doctor([]);

    expect(mockTrack).toHaveBeenCalledWith(
      'cli_doctor_result',
      expect.objectContaining({
        passed: true,
        failure_count: 0,
        checks: expect.any(Object),
      }),
    );
  });

  it('missing .dokkimi/ is a warning, not a failure', async () => {
    setupAllPassing();
    // .dokkimi dir doesn't exist but DB does
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('.dokkimi')) {
        return false;
      }
      if (p.endsWith('dokkimi.db')) {
        return true;
      }
      return true;
    });

    await doctor([]);

    // Should not fail (exit 1) just for missing .dokkimi/
    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      'cli_doctor_result',
      expect.objectContaining({
        passed: true,
        warning_count: 1,
      }),
    );
  });
});
