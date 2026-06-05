import {
  getConcurrencyPrefs,
  setConcurrencyPrefs,
  getMaxRunHistory,
  setMaxRunHistory,
  getUserPrefs,
} from '@dokkimi/config';
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
import { getProjectPath } from '../lib/project-path';

const HELP = `
Usage: dokkimi config

Interactively view and edit Dokkimi settings.

Options:
  --help, -h        Show this help message
`.trim();

const DEFAULT_MAX_CONCURRENT_TESTS = 6;
const DEFAULT_MAX_BOOTING_TESTS = 2;
const DEFAULT_MAX_RUN_HISTORY = 2;

type SettingsCategory = 'concurrency' | 'runHistory' | 'telemetry';

function runHistorySource(projectPath?: string): string {
  if (!projectPath) {
    return 'default';
  }
  const prefs = getUserPrefs();
  if (prefs.projects?.[projectPath]?.maxRunHistory !== undefined) {
    return 'project';
  }
  if (prefs.maxRunHistory !== undefined) {
    return 'global';
  }
  return 'default';
}

function buildTopMenuItems(): MenuItem<SettingsCategory>[] {
  const projectPath = getProjectPath();
  const concurrency = getConcurrencyPrefs(projectPath);
  const maxNs = concurrency.maxConcurrentTests ?? DEFAULT_MAX_CONCURRENT_TESTS;
  const maxBoot = concurrency.maxBootingTests ?? DEFAULT_MAX_BOOTING_TESTS;

  const maxHistory = getMaxRunHistory(projectPath);
  const historySource = runHistorySource(projectPath);

  const telemetryStatus = isTelemetryEnabled() ? 'on' : 'off';

  const pad = (s: string) => s.padEnd(20);

  return [
    {
      label: `${pad('Concurrency')} \x1b[90mmax namespaces: ${maxNs}, max booting: ${maxBoot}\x1b[0m`,
      value: 'concurrency',
    },
    {
      label: `${pad('Run History')} \x1b[90mkeep ${maxHistory} runs  (${historySource})\x1b[0m`,
      value: 'runHistory',
    },
    {
      label: `${pad('Telemetry')} \x1b[90m${telemetryStatus}\x1b[0m`,
      value: 'telemetry',
    },
  ];
}

async function editConcurrency(): Promise<boolean> {
  const projectPath = getProjectPath();
  const prefs = getUserPrefs();
  const globalPrefs = prefs.concurrency ?? {};
  const projectPrefs = projectPath
    ? (prefs.projects?.[projectPath]?.concurrency ?? null)
    : null;

  const globalMax =
    globalPrefs.maxConcurrentTests ?? DEFAULT_MAX_CONCURRENT_TESTS;
  const globalBoot = globalPrefs.maxBootingTests ?? DEFAULT_MAX_BOOTING_TESTS;

  type ConcurrencyAction =
    | 'maxConcurrentTests'
    | 'maxConcurrentTestsProject'
    | 'maxBootingTests'
    | 'maxBootingTestsProject'
    | 'resetProject';

  const pad = (s: string) => s.padEnd(28);
  const items: MenuItem<ConcurrencyAction>[] = [
    {
      label: `${pad('Max concurrent tests')} \x1b[90m${globalMax}${globalPrefs.maxConcurrentTests === undefined ? ' (default)' : ''}\x1b[0m`,
      value: 'maxConcurrentTests',
    },
    {
      label: `${pad('Max booting tests')} \x1b[90m${globalBoot}${globalPrefs.maxBootingTests === undefined ? ' (default)' : ''}\x1b[0m`,
      value: 'maxBootingTests',
    },
  ];

  if (projectPath) {
    items.push({
      label: `${pad('Project: concurrent')} \x1b[90m${projectPrefs?.maxConcurrentTests ?? 'not set'}\x1b[0m`,
      value: 'maxConcurrentTestsProject',
    });
    items.push({
      label: `${pad('Project: booting')} \x1b[90m${projectPrefs?.maxBootingTests ?? 'not set'}\x1b[0m`,
      value: 'maxBootingTestsProject',
    });
    if (projectPrefs) {
      items.push({
        label: '\x1b[90mRemove project overrides\x1b[0m',
        value: 'resetProject',
      });
    }
  }

  const result = await selectMenu(items, 'Concurrency Settings', {
    leftArrowBack: true,
  });
  if (!result) {
    return false;
  }

  if (result.value === 'resetProject') {
    setConcurrencyPrefs({}, projectPath);
    trackEvent('cli_config_changed', {
      category: 'concurrency',
      setting: 'reset',
      scope: 'project',
    });
    return true;
  }

  const isProject = result.value.endsWith('Project');
  const scope = isProject ? projectPath : undefined;
  const setting = result.value.replace('Project', '') as
    | 'maxConcurrentTests'
    | 'maxBootingTests';

  const currentValue =
    setting === 'maxConcurrentTests'
      ? isProject
        ? (projectPrefs?.maxConcurrentTests ?? globalMax)
        : globalMax
      : isProject
        ? (projectPrefs?.maxBootingTests ?? globalBoot)
        : globalBoot;

  const label =
    setting === 'maxConcurrentTests'
      ? 'Max concurrent tests'
      : 'Max booting tests';

  const value = await numberInput(label, currentValue, {
    min: 1,
    max: 50,
  });
  if (value === null) {
    return false;
  }

  setConcurrencyPrefs({ [setting]: value }, scope);
  trackEvent('cli_config_changed', {
    category: 'concurrency',
    setting,
    scope: scope ? 'project' : 'global',
    value,
  });
  return true;
}

async function editRunHistory(): Promise<boolean> {
  const projectPath = getProjectPath();
  const prefs = getUserPrefs();
  const globalValue = prefs.maxRunHistory ?? DEFAULT_MAX_RUN_HISTORY;
  const projectValue = projectPath
    ? prefs.projects?.[projectPath]?.maxRunHistory
    : undefined;
  const hasProjectOverride = projectValue !== undefined;
  const effective = getMaxRunHistory(projectPath);

  type HistoryAction = 'set' | 'setProject' | 'unsetProject';

  const globalLabel = `${globalValue}${prefs.maxRunHistory === undefined ? ' (default)' : ''}`;
  const items: MenuItem<HistoryAction>[] = [
    {
      label: `Set global default       \x1b[90m${globalLabel}\x1b[0m`,
      value: 'set',
    },
  ];

  if (projectPath) {
    const projectLabel = hasProjectOverride ? String(projectValue) : 'not set';
    items.push({
      label: `Set for this project     \x1b[90m${projectLabel}\x1b[0m`,
      value: 'setProject',
    });
    if (hasProjectOverride) {
      items.push({
        label: '\x1b[90mRemove project override\x1b[0m',
        value: 'unsetProject',
      });
    }
  }

  const result = await selectMenu(items, 'Run History', {
    leftArrowBack: true,
  });
  if (!result) {
    return false;
  }

  if (result.value === 'unsetProject') {
    setMaxRunHistory(undefined, projectPath);
    trackEvent('cli_config_changed', {
      category: 'runHistory',
      setting: 'maxRunHistory',
      scope: 'project',
      action: 'unset',
    });
    return false;
  }

  const scope = result.value === 'setProject' ? projectPath : undefined;
  const initial = scope ? (projectValue ?? effective) : globalValue;
  const value = await numberInput('Max run history', initial, {
    min: 1,
    max: 20,
  });
  if (value !== null) {
    setMaxRunHistory(
      value === DEFAULT_MAX_RUN_HISTORY ? undefined : value,
      scope,
    );
    trackEvent('cli_config_changed', {
      category: 'runHistory',
      setting: 'maxRunHistory',
      scope: scope ? 'project' : 'global',
      value,
    });
    return false;
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
      case 'runHistory':
        changed = await editRunHistory();
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
