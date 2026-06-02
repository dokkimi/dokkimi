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

const DEFAULT_MAX_NAMESPACES = 6;
const DEFAULT_MAX_BOOTING = 2;

type SettingsCategory = 'concurrency' | 'telemetry';

function buildTopMenuItems(): MenuItem<SettingsCategory>[] {
  const concurrency = getConcurrencyPrefs();
  const maxNs = concurrency.maxNamespaces ?? DEFAULT_MAX_NAMESPACES;
  const maxBoot = concurrency.maxBooting ?? DEFAULT_MAX_BOOTING;

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
  const currentMax = prefs.maxNamespaces ?? DEFAULT_MAX_NAMESPACES;
  const currentBoot = prefs.maxBooting ?? DEFAULT_MAX_BOOTING;

  type ConcurrencyAction = 'maxNamespaces' | 'maxBooting' | 'reset';

  const items: MenuItem<ConcurrencyAction>[] = [
    {
      label: `Max parallel namespaces   \x1b[90m${currentMax}${prefs.maxNamespaces === undefined ? ' (default)' : ''}\x1b[0m`,
      value: 'maxNamespaces',
    },
    {
      label: `Max booting namespaces    \x1b[90m${currentBoot}${prefs.maxBooting === undefined ? ' (default)' : ''}\x1b[0m`,
      value: 'maxBooting',
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

  if (result.value === 'maxNamespaces') {
    const value = await numberInput('Max parallel namespaces', currentMax, {
      min: 1,
      max: 50,
    });
    if (value !== null) {
      setConcurrencyPrefs({
        ...prefs,
        maxNamespaces: value === DEFAULT_MAX_NAMESPACES ? undefined : value,
      });
      trackEvent('cli_config_changed', {
        category: 'concurrency',
        setting: 'maxNamespaces',
        value,
      });
      return true;
    }
  }

  if (result.value === 'maxBooting') {
    const value = await numberInput('Max booting namespaces', currentBoot, {
      min: 1,
      max: 50,
    });
    if (value !== null) {
      const updated = { ...prefs, maxBooting: value };
      setConcurrencyPrefs(updated);
      trackEvent('cli_config_changed', {
        category: 'concurrency',
        setting: 'maxBooting',
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
