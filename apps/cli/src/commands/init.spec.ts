jest.mock('fs');
jest.mock('../lib/cli-utils', () => ({
  ...jest.requireActual('../lib/cli-utils'),
  prompt: jest.fn(),
}));
const mockConfig = { DOKKIMI_VERSION: '1.0.0' };
jest.mock('@dokkimi/config', () => mockConfig);

import * as fs from 'fs';
import { prompt } from '../lib/cli-utils';
import { init } from './init';

const mockExistsSync = fs.existsSync as jest.Mock;
const mockMkdirSync = fs.mkdirSync as jest.Mock;
const mockWriteFileSync = fs.writeFileSync as jest.Mock;
const mockPrompt = prompt as jest.Mock;

let consoleSpy: jest.SpyInstance;
let exitSpy: jest.SpyInstance;

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
  mockConfig.DOKKIMI_VERSION = '1.0.0';
});

afterEach(() => {
  consoleSpy.mockRestore();
  exitSpy.mockRestore();
});

describe('init', () => {
  it('shows help and exits 0 with --help', async () => {
    await expect(init(['--help'])).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Usage: dokkimi init'),
    );
  });

  it('shows help and exits 0 with -h', async () => {
    await expect(init(['-h'])).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('creates .dokkimi/ directory structure when it does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    await init([]);

    // Should create 3 subdirectories
    expect(mockMkdirSync).toHaveBeenCalledTimes(3);
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('definitions'),
      { recursive: true },
    );
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('shared'),
      { recursive: true },
    );
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('init-files'),
      { recursive: true },
    );
  });

  it('writes config.yaml with CLI version', async () => {
    mockExistsSync.mockReturnValue(false);
    mockConfig.DOKKIMI_VERSION = '2.3.4';

    await init([]);

    const configCall = mockWriteFileSync.mock.calls.find((c: unknown[]) =>
      (c[0] as string).endsWith('config.yaml'),
    );
    expect(configCall).toBeDefined();
    expect(configCall![1]).toContain('dokkimi: 2.3.4');
  });

  it('writes example definition and init SQL files', async () => {
    mockExistsSync.mockReturnValue(false);

    await init([]);

    // 4 files: config.yaml, example.yaml, postgres.yaml, init.sql
    expect(mockWriteFileSync).toHaveBeenCalledTimes(4);

    const writtenPaths = mockWriteFileSync.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(writtenPaths).toEqual(
      expect.arrayContaining([
        expect.stringContaining('config.yaml'),
        expect.stringContaining('example.yaml'),
        expect.stringContaining('postgres.yaml'),
        expect.stringContaining('init.sql'),
      ]),
    );

    // Example definition contains service definition
    const exampleCall = mockWriteFileSync.mock.calls.find((c: unknown[]) =>
      (c[0] as string).endsWith('example.yaml'),
    );
    expect(exampleCall![1]).toContain('type: SERVICE');

    // Init SQL contains CREATE TABLE
    const sqlCall = mockWriteFileSync.mock.calls.find((c: unknown[]) =>
      (c[0] as string).endsWith('init.sql'),
    );
    expect(sqlCall![1]).toContain('CREATE TABLE');
  });

  it('prompts and aborts if .dokkimi/ already exists and user declines', async () => {
    mockExistsSync.mockReturnValue(true);
    mockPrompt.mockResolvedValue('n');

    await expect(init([])).rejects.toThrow('process.exit');

    expect(mockPrompt).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith('Aborted.');
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  it('overwrites when .dokkimi/ exists and user confirms', async () => {
    mockExistsSync.mockReturnValue(true);
    mockPrompt.mockResolvedValue('y');

    await init([]);

    expect(mockMkdirSync).toHaveBeenCalledTimes(3);
    expect(mockWriteFileSync).toHaveBeenCalledTimes(4);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Created .dokkimi/'),
    );
  });

  it('prints success message after scaffolding', async () => {
    mockExistsSync.mockReturnValue(false);

    await init([]);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Created .dokkimi/ with example files'),
    );
  });
});
