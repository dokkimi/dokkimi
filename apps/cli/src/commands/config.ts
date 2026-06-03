import { getConcurrencyPrefs, setConcurrencyPrefs } from '@dokkimi/config';
import {
  isTelemetryEnabled,
  setTelemetryEnabled,
  trackEvent,
} from '@dokkimi/telemetry';
import { selectMenu, MenuItem } from '../lib/menu';
import { enterAltScreen, exitAltScreen } from '../lib/terminal';
import { numberInput } from '../lib/number-input';
import {
  shutdownServices,
  ensureServicesRunning,
  resolveAppRoot,
} from '@dokkimi/service-manager';
import { loadConfig } from '@dokkimi/config';

const HELP = `
Usage: dokkimi config

Interactively view and edit Dokkimi settings.

Options:
  --help, -h        Show this help message
`.trim();

const DEFAULT_MAX_CONCURRENT_TESTS = 6;
const DEFAULT_MAX_BOOTING_TESTS = 2;

type SettingsCategory = 'concurrency' | 'telemetry';

function buildTopMenuItems(): MenuItem<SettingsCategory>[] {
  const concurrency = getConcurrencyPrefs();
  const maxNs = concurrency.maxConcurrentTests ?? DEFAULT_MAX_CONCURRENT_TESTS;
  const maxBoot = concurrency.maxBootingTests ?? DEFAULT_MAX_BOOTING_TESTS;

  const telemetryStatus = isTelemetryEnabled() ? 'on' : 'off';

  return [
    {
      label: `Concurrency          \x1b[90mmax namespaces: ${maxNs}, max booting: ${maxBoot}\x1b[0m`,
      value: 'concurrency',
    },
    {
      label: `Telemetry            \x1b[90m${telemetryStatus}\x1b[0m`,
      value: 'telemetry',
    },
  ];
}

async function editConcurrency(): Promise<boolean> {
  const prefs = getConcurrencyPrefs();
  const currentMax = prefs.maxConcurrentTests ?? DEFAULT_MAX_CONCURRENT_TESTS;
  const currentBoot = prefs.maxBootingTests ?? DEFAULT_MAX_BOOTING_TESTS;

  type ConcurrencyAction = 'maxConcurrentTests' | 'maxBootingTests' | 'reset';

  const items: MenuItem<ConcurrencyAction>[] = [
    {
      label: `Max concurrent tests      \x1b[90m${currentMax}${prefs.maxConcurrentTests === undefined ? ' (default)' : ''}\x1b[0m`,
      value: 'maxConcurrentTests',
    },
    {
      label: `Max booting tests         \x1b[90m${currentBoot}${prefs.maxBootingTests === undefined ? ' (default)' : ''}\x1b[0m`,
      value: 'maxBootingTests',
    },
    {
      label: '\x1b[90mReset to defaults\x1b[0m',
      value: 'reset',
    },
  ];

  const result = await selectMenu(items, 'Concurrency Settings', {
    leftArrowBack: true,
  });
  if (!result) {
    return false;
  }

  if (result.value === 'reset') {
    setConcurrencyPrefs({});
    trackEvent('cli_config_changed', {
      category: 'concurrency',
      setting: 'reset',
    });
    return true;
  }

  if (result.value === 'maxConcurrentTests') {
    const value = await numberInput('Max concurrent tests', currentMax, {
      min: 1,
      max: 50,
    });
    if (value !== null) {
      setConcurrencyPrefs({
        ...prefs,
        maxConcurrentTests:
          value === DEFAULT_MAX_CONCURRENT_TESTS ? undefined : value,
      });
      trackEvent('cli_config_changed', {
        category: 'concurrency',
        setting: 'maxConcurrentTests',
        value,
      });
      return true;
    }
  }

  if (result.value === 'maxBootingTests') {
    const value = await numberInput('Max booting tests', currentBoot, {
      min: 1,
      max: 50,
    });
    if (value !== null) {
      const updated = { ...prefs, maxBootingTests: value };
      setConcurrencyPrefs(updated);
      trackEvent('cli_config_changed', {
        category: 'concurrency',
        setting: 'maxBootingTests',
        value,
      });
      return true;
    }
  }

  return false;
}

async function editTelemetry(): Promise<boolean> {
  const enabled = isTelemetryEnabled();

  const items: MenuItem<boolean>[] = [
    {
      label: enabled ? 'On  \x1b[32m✔\x1b[0m' : 'On',
      value: true,
    },
    {
      label: !enabled ? 'Off  \x1b[32m✔\x1b[0m' : 'Off',
      value: false,
    },
  ];

  const result = await selectMenu(items, 'Telemetry', {
    leftArrowBack: true,
    initialIndex: enabled ? 0 : 1,
  });
  if (!result) {
    return false;
  }

  if (result.value === enabled) {
    return false;
  }
  setTelemetryEnabled(result.value);
  trackEvent('cli_config_changed', {
    category: 'telemetry',
    setting: 'enabled',
    value: result.value,
  });
  return true;
}

export async function configCommand(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }

  trackEvent('cli_config_opened', {});

  enterAltScreen();
  let needsReboot = false;

  while (true) {
    const items = buildTopMenuItems();
    const result = await selectMenu(items, 'Dokkimi Settings');
    if (!result) {
      break;
    }

    let changed = false;
    switch (result.value) {
      case 'concurrency':
        changed = await editConcurrency();
        break;
      case 'telemetry':
        changed = await editTelemetry();
        break;
    }
    if (changed) {
      needsReboot = true;
    }
  }

  if (needsReboot) {
    const rebootItems: MenuItem<'reboot' | 'exit'>[] = [
      { label: 'Reboot and apply changes', value: 'reboot' },
      { label: 'Exit without rebooting', value: 'exit' },
    ];
    const rebootResult = await selectMenu(
      rebootItems,
      'Settings changed — reboot to apply?',
    );

    exitAltScreen();

    if (rebootResult?.value === 'reboot') {
      console.log('Rebooting Dokkimi services...\n');
      await shutdownServices();
      const config = loadConfig();
      const appRoot = resolveAppRoot(__dirname);
      await ensureServicesRunning(appRoot, config);
    } else {
      console.log('Run \x1b[1mdokkimi reboot\x1b[0m to apply changes.');
    }
  } else {
    exitAltScreen();
  }
}
