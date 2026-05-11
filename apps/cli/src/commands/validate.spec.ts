jest.mock('@dokkimi/definition-resolver');
jest.mock('@dokkimi/telemetry');
jest.mock('../lib/version');
jest.mock('../lib/update-check');

import { resolveDefinitions } from '@dokkimi/definition-resolver';
import { trackEvent } from '@dokkimi/telemetry';
import { warnIfVersionMismatch } from '../lib/version';
import { checkForUpdate } from '../lib/update-check';
import { validate } from './validate';

const mockResolve = resolveDefinitions as jest.Mock;
const mockTrack = trackEvent as jest.Mock;
const mockWarnVersion = warnIfVersionMismatch as jest.Mock;
const mockCheckUpdate = checkForUpdate as jest.Mock;

let consoleSpy: jest.SpyInstance;
let exitSpy: jest.SpyInstance;

beforeEach(() => {
  consoleSpy = jest.spyOn(console, 'log').mockImplementation();
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });
  mockResolve.mockReset();
  mockTrack.mockReset();
  mockWarnVersion.mockReset();
  mockCheckUpdate.mockReset();
});

afterEach(() => {
  consoleSpy.mockRestore();
  exitSpy.mockRestore();
});

describe('validate', () => {
  it('shows help and exits 0 with --help', async () => {
    await expect(validate(['--help'])).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Usage: dokkimi validate'),
    );
  });

  it('shows help and exits 0 with -h', async () => {
    await expect(validate(['-h'])).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('prints success and exits 0 when no errors or warnings', async () => {
    mockResolve.mockReturnValue({
      config: { dokkimi: '1.0.0' },
      definitions: [{ name: 'test1' }, { name: 'test2' }],
      errors: [],
    });

    await validate([]);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Resolved 2 definitions'),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('All files valid.'),
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('prints errors per file and exits 1 when there are errors', async () => {
    mockResolve.mockReturnValue({
      config: {},
      definitions: [{ name: 'test1' }],
      errors: [
        {
          file: 'service.yaml',
          errors: ['Missing required field: name', 'Invalid port'],
          warnings: [],
        },
        {
          file: 'db.yaml',
          errors: ['Unknown database type'],
          warnings: ['Deprecated field: driver'],
        },
      ],
    });

    await expect(validate([])).rejects.toThrow('process.exit');

    expect(consoleSpy).toHaveBeenCalledWith('service.yaml:');
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Missing required field: name'),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid port'),
    );
    expect(consoleSpy).toHaveBeenCalledWith('db.yaml:');
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown database type'),
    );
    // Summary: 3 errors, 1 warning
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('3 errors'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('prints warnings and exits 0 when warnings only', async () => {
    mockResolve.mockReturnValue({
      config: {},
      definitions: [{ name: 'test1' }],
      errors: [
        {
          file: 'service.yaml',
          errors: [],
          warnings: ['Deprecated field: driver'],
        },
      ],
    });

    await validate([]);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('No errors.'),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('1 warning'),
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('handles no definition files found', async () => {
    mockResolve.mockReturnValue({
      config: {},
      definitions: [],
      errors: [],
    });

    await validate([]);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Resolved 0 definitions'),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('All files valid.'),
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('tracks telemetry with correct counts', async () => {
    mockResolve.mockReturnValue({
      config: {},
      definitions: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      errors: [
        {
          file: 'x.yaml',
          errors: ['err1'],
          warnings: ['warn1', 'warn2'],
        },
      ],
    });

    await expect(validate([])).rejects.toThrow('process.exit');

    expect(mockTrack).toHaveBeenCalledWith('cli_validate_result', {
      definition_count: 3,
      error_count: 1,
      warning_count: 2,
    });
  });

  it('passes target path to resolveDefinitions', async () => {
    mockResolve.mockReturnValue({
      config: {},
      definitions: [],
      errors: [],
    });

    await validate(['/some/path']);

    expect(mockResolve).toHaveBeenCalledWith('/some/path');
  });

  it('calls checkForUpdate and warnIfVersionMismatch', async () => {
    const config = { dokkimi: '1.0.0' };
    mockResolve.mockReturnValue({
      config,
      definitions: [],
      errors: [],
    });

    await validate([]);

    expect(mockCheckUpdate).toHaveBeenCalled();
    expect(mockWarnVersion).toHaveBeenCalledWith(config);
  });
});
