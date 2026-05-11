jest.mock('@dokkimi/service-manager', () => ({
  shutdownServices: jest.fn(),
  ensureServicesRunning: jest.fn(),
  resolveAppRoot: jest.fn(() => '/mock/app/root'),
}));

jest.mock('@dokkimi/config', () => ({
  loadConfig: jest.fn(() => ({
    services: { controlTower: { host: 'localhost', port: 19001 } },
  })),
}));

import {
  shutdownServices,
  ensureServicesRunning,
} from '@dokkimi/service-manager';
import { reboot } from './reboot';

const mockShutdown = shutdownServices as jest.MockedFunction<
  typeof shutdownServices
>;
const mockEnsure = ensureServicesRunning as jest.MockedFunction<
  typeof ensureServicesRunning
>;

let processExitSpy: jest.SpyInstance;
let consoleLogSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });
  consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  mockShutdown.mockResolvedValue(undefined);
  mockEnsure.mockResolvedValue(undefined);
});

afterEach(() => {
  processExitSpy.mockRestore();
  consoleLogSpy.mockRestore();
});

describe('reboot', () => {
  it('prints help and exits on --help', async () => {
    await expect(reboot(['--help'])).rejects.toThrow('process.exit');
    expect(processExitSpy).toHaveBeenCalledWith(0);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Usage: dokkimi reboot'),
    );
  });

  it('prints help and exits on -h', async () => {
    await expect(reboot(['-h'])).rejects.toThrow('process.exit');
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it('calls shutdown then ensures services running', async () => {
    await reboot([]);

    expect(mockShutdown).toHaveBeenCalled();
    expect(mockEnsure).toHaveBeenCalledWith(
      '/mock/app/root',
      expect.objectContaining({
        services: expect.anything(),
      }),
    );

    // Verify order: shutdown before ensure
    const shutdownOrder = mockShutdown.mock.invocationCallOrder[0];
    const ensureOrder = mockEnsure.mock.invocationCallOrder[0];
    expect(shutdownOrder).toBeLessThan(ensureOrder);
  });
});
