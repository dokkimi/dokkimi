jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
    writeFileSync: jest.fn(),
    rmSync: jest.fn(),
  };
});

jest.mock('../lib/cli-utils', () => ({
  prompt: jest.fn(),
}));

jest.mock('@dokkimi/service-manager', () => ({
  shutdownServices: jest.fn(),
}));

jest.mock('@dokkimi/telemetry', () => ({
  trackEvent: jest.fn(),
  shutdownTelemetry: jest.fn(),
}));

jest.mock('@dokkimi/platform', () => ({
  execSilent: jest.fn(),
}));

import * as fs from 'fs';
import { prompt } from '../lib/cli-utils';
import { shutdownServices } from '@dokkimi/service-manager';
import { trackEvent, shutdownTelemetry } from '@dokkimi/telemetry';
import { execSilent } from '@dokkimi/platform';
import { uninstall } from './uninstall';

const mockExistsSync = fs.existsSync as jest.Mock;
const mockReadFileSync = fs.readFileSync as jest.Mock;
const mockWriteFileSync = fs.writeFileSync as jest.Mock;
const mockRmSync = fs.rmSync as jest.Mock;
const mockPrompt = prompt as jest.MockedFunction<typeof prompt>;
const mockShutdown = shutdownServices as jest.MockedFunction<
  typeof shutdownServices
>;
const mockTrackEvent = trackEvent as jest.MockedFunction<typeof trackEvent>;
const mockShutdownTelemetry = shutdownTelemetry as jest.MockedFunction<
  typeof shutdownTelemetry
>;
const mockExecSilent = execSilent as jest.MockedFunction<typeof execSilent>;

let processExitSpy: jest.SpyInstance;
let consoleLogSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  processExitSpy = jest
    .spyOn(process, 'exit')
    .mockImplementation(() => undefined as never);
  consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  mockShutdown.mockResolvedValue(undefined);
  mockShutdownTelemetry.mockResolvedValue(undefined);
  mockExecSilent.mockReturnValue('');
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue('');
  mockWriteFileSync.mockReturnValue(undefined);
  mockRmSync.mockReturnValue(undefined);
});

afterEach(() => {
  processExitSpy.mockRestore();
  consoleLogSpy.mockRestore();
});

describe('uninstall', () => {
  it('prints help and exits on --help', async () => {
    await uninstall(['--help']);
    expect(processExitSpy).toHaveBeenCalledWith(0);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Usage: dokkimi uninstall'),
    );
  });

  it('prints help and exits on -h', async () => {
    await uninstall(['-h']);
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it('prompts for confirmation and exits on n', async () => {
    mockPrompt.mockResolvedValue('n');

    await uninstall([]);

    expect(mockPrompt).toHaveBeenCalledWith(expect.stringContaining('(y/n)'));
    expect(mockTrackEvent).toHaveBeenCalledWith('cli_uninstall', {
      confirmed: false,
    });
    expect(mockShutdown).not.toHaveBeenCalled();
  });

  it('runs cleanup steps when user confirms', async () => {
    mockPrompt.mockResolvedValue('y');
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('some content');

    await uninstall([]);

    // Step 1: shutdown
    expect(mockShutdown).toHaveBeenCalled();

    // Step 3: docker images
    expect(mockExecSilent).toHaveBeenCalledWith(
      expect.stringContaining('docker images'),
      expect.anything(),
    );

    // Step 4: remove data directory
    expect(mockRmSync).toHaveBeenCalledWith(
      expect.stringContaining('.dokkimi'),
      expect.objectContaining({ recursive: true, force: true }),
    );

    // Telemetry tracked as confirmed
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'cli_uninstall',
      expect.objectContaining({ confirmed: true }),
    );
  });

  it('handles partial failures gracefully', async () => {
    mockPrompt.mockResolvedValue('y');
    mockShutdown.mockRejectedValue(new Error('not running'));
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    await expect(uninstall([])).resolves.toBeUndefined();

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Dokkimi was not running'),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Dokkimi has been removed'),
    );
  });
});
