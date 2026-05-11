jest.mock('@dokkimi/service-manager', () => ({
  shutdownServices: jest.fn(),
}));

jest.mock('@dokkimi/platform', () => ({
  findProcessesByPattern: jest.fn(() => []),
  killProcess: jest.fn(),
}));

import { shutdownServices } from '@dokkimi/service-manager';
import { shutdown } from './shutdown';

const mockShutdown = shutdownServices as jest.MockedFunction<
  typeof shutdownServices
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
});

afterEach(() => {
  processExitSpy.mockRestore();
  consoleLogSpy.mockRestore();
});

describe('shutdown', () => {
  it('prints help and exits on --help', async () => {
    await expect(shutdown(['--help'])).rejects.toThrow('process.exit');
    expect(processExitSpy).toHaveBeenCalledWith(0);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Usage: dokkimi shutdown'),
    );
  });

  it('prints help and exits on -h', async () => {
    await expect(shutdown(['-h'])).rejects.toThrow('process.exit');
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it('calls shutdownServices', async () => {
    await shutdown([]);
    expect(mockShutdown).toHaveBeenCalled();
  });
});
