jest.mock('../lib/cli-utils', () => ({
  fetchPostWithError: jest.fn(),
  checkService: jest.fn(),
}));
jest.mock('@dokkimi/config', () => ({
  loadConfig: jest.fn(() => ({ services: { controlTower: {} } })),
  buildServiceUrl: jest.fn(() => 'http://ct'),
}));

import { fetchPostWithError, checkService } from '../lib/cli-utils';
import { stop } from './stop';

const mockPost = fetchPostWithError as jest.Mock;
const mockCheck = checkService as jest.Mock;

let log: jest.SpyInstance;
let error: jest.SpyInstance;
let exit: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockCheck.mockResolvedValue({ healthy: true });
  log = jest.spyOn(console, 'log').mockImplementation(() => {});
  error = jest.spyOn(console, 'error').mockImplementation(() => {});
  exit = jest.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });
});

afterEach(() => {
  log.mockRestore();
  error.mockRestore();
  exit.mockRestore();
});

describe('stop', () => {
  it('reports a stopped run', async () => {
    mockPost.mockResolvedValue({ data: { runId: 'r', status: 'CANCELLED' } });
    await stop([]);
    expect(log).toHaveBeenCalledWith('Run stopped.');
  });

  it('reports when nothing is running', async () => {
    mockPost.mockResolvedValue({ data: { status: 'NO_ACTIVE_RUN' } });
    await stop([]);
    expect(log).toHaveBeenCalledWith('No active run to stop.');
  });

  // Before, a failed request printed "Run stopped." and exited 0
  it('reports a failure and exits 1', async () => {
    mockPost.mockResolvedValue({ error: 'HTTP 500' });
    await expect(stop([])).rejects.toThrow('process.exit');
    expect(error).toHaveBeenCalledWith('Failed to stop run: HTTP 500');
    expect(log).not.toHaveBeenCalledWith('Run stopped.');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('reports a failure in JSON', async () => {
    mockPost.mockResolvedValue({ error: 'timed out' });
    await expect(stop(['--json'])).rejects.toThrow('process.exit');
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ success: false, error: 'timed out' }),
    );
    expect(exit).toHaveBeenCalledWith(1);
  });
});
