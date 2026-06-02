jest.mock('fs', () => ({
  readFileSync: jest.fn(),
  existsSync: jest.fn(),
}));
jest.mock('../lib/menu');
jest.mock('../lib/number-input');
jest.mock('../lib/terminal');
jest.mock('@dokkimi/config');
jest.mock('@dokkimi/telemetry');
jest.mock('@dokkimi/service-manager');

import { loadConfig } from '@dokkimi/config';
import { selectMenu } from '../lib/menu';
import { numberInput } from '../lib/number-input';
import { enterAltScreen, exitAltScreen } from '../lib/terminal';
import { getConcurrencyPrefs, setConcurrencyPrefs } from '@dokkimi/config';
import {
  isTelemetryEnabled,
  setTelemetryEnabled,
  trackEvent,
} from '@dokkimi/telemetry';
import {
  shutdownServices,
  ensureServicesRunning,
  resolveAppRoot,
} from '@dokkimi/service-manager';
import { configCommand } from './config';

const mockSelectMenu = selectMenu as jest.Mock;
const mockNumberInput = numberInput as jest.Mock;
const mockEnterAlt = enterAltScreen as jest.Mock;
const mockExitAlt = exitAltScreen as jest.Mock;
const mockGetConcurrency = getConcurrencyPrefs as jest.Mock;
const mockSetConcurrency = setConcurrencyPrefs as jest.Mock;
const mockIsTelemetry = isTelemetryEnabled as jest.Mock;
const mockSetTelemetry = setTelemetryEnabled as jest.Mock;
const mockTrack = trackEvent as jest.Mock;
const mockShutdown = shutdownServices as jest.Mock;
const mockEnsureRunning = ensureServicesRunning as jest.Mock;
const mockResolveAppRoot = resolveAppRoot as jest.Mock;
const mockLoadConfig = loadConfig as jest.Mock;

let consoleSpy: jest.SpyInstance;
let exitSpy: jest.SpyInstance;
let stdoutWriteSpy: jest.SpyInstance;

beforeEach(() => {
  consoleSpy = jest.spyOn(console, 'log').mockImplementation();
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });
  stdoutWriteSpy = jest
    .spyOn(process.stdout, 'write')
    .mockImplementation(() => true);

  mockGetConcurrency.mockReturnValue({});
  mockIsTelemetry.mockReturnValue(true);
  mockLoadConfig.mockReturnValue({
    services: { controlTower: { host: 'localhost', port: 19001 } },
  });
  mockResolveAppRoot.mockReturnValue('/app');
  mockShutdown.mockResolvedValue(undefined);
  mockEnsureRunning.mockResolvedValue(undefined);

  jest.clearAllMocks();
});

afterEach(() => {
  consoleSpy.mockRestore();
  exitSpy.mockRestore();
  stdoutWriteSpy.mockRestore();
});

describe('configCommand', () => {
  it('shows help and exits with --help', async () => {
    await expect(configCommand(['--help'])).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Usage: dokkimi config'),
    );
  });

  it('shows help and exits with -h', async () => {
    await expect(configCommand(['-h'])).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('shows main settings menu and exits on escape', async () => {
    // User escapes immediately from top-level menu
    mockSelectMenu.mockResolvedValueOnce(null);

    await configCommand([]);

    expect(mockEnterAlt).toHaveBeenCalled();
    expect(mockExitAlt).toHaveBeenCalled();
    expect(mockSelectMenu).toHaveBeenCalledTimes(1);

    const items = mockSelectMenu.mock.calls[0][0];
    expect(items).toHaveLength(2);
    expect(items[0].label).toContain('Concurrency');
    expect(items[1].label).toContain('Telemetry');
  });

  it('updates concurrency setting (maxNamespaces)', async () => {
    mockGetConcurrency.mockReturnValue({ maxNamespaces: 6 });

    // Top menu -> select concurrency
    mockSelectMenu
      .mockResolvedValueOnce({ value: 'concurrency', index: 0 })
      // Concurrency sub-menu -> select maxNamespaces
      .mockResolvedValueOnce({ value: 'maxNamespaces', index: 0 })
      // Back to top menu -> escape
      .mockResolvedValueOnce(null)
      // Reboot prompt -> exit without rebooting
      .mockResolvedValueOnce({ value: 'exit', index: 1 });

    mockNumberInput.mockResolvedValueOnce(10);

    await configCommand([]);

    expect(mockSetConcurrency).toHaveBeenCalledWith(
      expect.objectContaining({ maxNamespaces: 10 }),
    );
    expect(mockTrack).toHaveBeenCalledWith('cli_config_changed', {
      category: 'concurrency',
      setting: 'maxNamespaces',
      value: 10,
    });
  });

  it('toggles telemetry off', async () => {
    mockIsTelemetry.mockReturnValue(true);

    // Top menu -> select telemetry
    mockSelectMenu
      .mockResolvedValueOnce({ value: 'telemetry', index: 2 })
      // Telemetry sub-menu -> select Off
      .mockResolvedValueOnce({ value: false, index: 1 })
      // Back to top -> escape
      .mockResolvedValueOnce(null)
      // Reboot prompt -> exit
      .mockResolvedValueOnce({ value: 'exit', index: 1 });

    await configCommand([]);

    expect(mockSetTelemetry).toHaveBeenCalledWith(false);
    expect(mockTrack).toHaveBeenCalledWith('cli_config_changed', {
      category: 'telemetry',
      setting: 'enabled',
      value: false,
    });
  });

  it('toggles telemetry on', async () => {
    mockIsTelemetry.mockReturnValue(false);

    mockSelectMenu
      .mockResolvedValueOnce({ value: 'telemetry', index: 2 })
      .mockResolvedValueOnce({ value: true, index: 0 })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ value: 'exit', index: 1 });

    await configCommand([]);

    expect(mockSetTelemetry).toHaveBeenCalledWith(true);
  });

  it('triggers reboot when settings change and user selects reboot', async () => {
    mockGetConcurrency.mockReturnValue({});

    mockSelectMenu
      .mockResolvedValueOnce({ value: 'concurrency', index: 0 })
      .mockResolvedValueOnce({ value: 'maxNamespaces', index: 0 })
      .mockResolvedValueOnce(null)
      // Reboot prompt -> reboot
      .mockResolvedValueOnce({ value: 'reboot', index: 0 });

    mockNumberInput.mockResolvedValueOnce(8);

    await configCommand([]);

    expect(mockShutdown).toHaveBeenCalled();
    expect(mockEnsureRunning).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith('Rebooting Dokkimi services...\n');
  });

  it('does not trigger reboot when no settings changed', async () => {
    // Escape immediately
    mockSelectMenu.mockResolvedValueOnce(null);

    await configCommand([]);

    expect(mockShutdown).not.toHaveBeenCalled();
    expect(mockEnsureRunning).not.toHaveBeenCalled();
    // No reboot prompt should be shown — only 1 selectMenu call
    expect(mockSelectMenu).toHaveBeenCalledTimes(1);
  });

  it('shows reboot hint when user exits without rebooting', async () => {
    mockIsTelemetry.mockReturnValue(true);

    mockSelectMenu
      .mockResolvedValueOnce({ value: 'telemetry', index: 2 })
      .mockResolvedValueOnce({ value: false, index: 1 })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ value: 'exit', index: 1 });

    await configCommand([]);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('dokkimi reboot'),
    );
    expect(mockShutdown).not.toHaveBeenCalled();
  });

  it('tracks cli_config_opened event', async () => {
    mockSelectMenu.mockResolvedValueOnce(null);

    await configCommand([]);

    expect(mockTrack).toHaveBeenCalledWith('cli_config_opened', {});
  });

  it('updates concurrency setting (maxBooting)', async () => {
    mockGetConcurrency.mockReturnValue({ maxBooting: 2 });

    mockSelectMenu
      .mockResolvedValueOnce({ value: 'concurrency', index: 0 })
      .mockResolvedValueOnce({ value: 'maxBooting', index: 1 })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ value: 'exit', index: 1 });

    mockNumberInput.mockResolvedValueOnce(4);

    await configCommand([]);

    expect(mockSetConcurrency).toHaveBeenCalledWith(
      expect.objectContaining({ maxBooting: 4 }),
    );
    expect(mockTrack).toHaveBeenCalledWith('cli_config_changed', {
      category: 'concurrency',
      setting: 'maxBooting',
      value: 4,
    });
  });

  it('resets concurrency to defaults', async () => {
    mockGetConcurrency.mockReturnValue({ maxNamespaces: 10, maxBooting: 5 });

    mockSelectMenu
      .mockResolvedValueOnce({ value: 'concurrency', index: 0 })
      .mockResolvedValueOnce({ value: 'reset', index: 2 })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ value: 'exit', index: 1 });

    await configCommand([]);

    expect(mockSetConcurrency).toHaveBeenCalledWith({});
    expect(mockTrack).toHaveBeenCalledWith('cli_config_changed', {
      category: 'concurrency',
      setting: 'reset',
    });
  });

  it('no change when numberInput returns null (user cancels)', async () => {
    mockGetConcurrency.mockReturnValue({});

    mockSelectMenu
      .mockResolvedValueOnce({ value: 'concurrency', index: 0 })
      .mockResolvedValueOnce({ value: 'maxNamespaces', index: 0 })
      .mockResolvedValueOnce(null);

    mockNumberInput.mockResolvedValueOnce(null);

    await configCommand([]);

    expect(mockSetConcurrency).not.toHaveBeenCalled();
    expect(mockShutdown).not.toHaveBeenCalled();
  });
});
