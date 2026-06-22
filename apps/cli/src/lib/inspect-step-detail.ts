import { fetchJson, resolveUri } from '../lib/cli-utils';
import { selectMenu, MenuItem } from '../lib/menu';
import {
  formatLogLine,
  formatDbLogLine,
  itemTypeColor,
  instanceStatusBadge,
} from '../lib/formatting';
import {
  stripIds,
  formatHttpLog,
  formatDbLog,
  formatConsoleLogs,
  formatTestExecutionLogs,
  openInEditor,
  openFile,
} from '../lib/editor';
import {
  filterLogsByTimeWindow,
  getGroupVariables,
} from '../lib/inspect-helpers';
import type {
  InstanceSummary,
  DefinitionSnapshot,
  InstanceItemStatus,
  HttpLog,
  DatabaseLog,
  DatabaseLogsResponse,
  TestExecutionLog,
  AssertionResult,
  ArtifactRow,
  FlatStepGroup,
  ConsoleLog,
  ConsoleLogsResponse,
  StepDetailAction,
  UiTimelineEntry,
  UiTimelineChild,
} from '../lib/inspect-types';
import {
  formatUiTimeline,
  formatStepCallTree,
} from '../lib/format-ui-timeline';
import {
  filterDbLogsByTimeWindow,
  getGroupTimeWindow,
  formatAssertionReport,
} from '../lib/inspect-step-formatters';

export async function showStepDetail(
  ctUrl: string,
  instance: InstanceSummary,
  flatGroups: FlatStepGroup[],
  stepIndex: number,
  subStepIndex: number,
  stepLabel: string,
  assertionResults: AssertionResult[],
  execLogs: TestExecutionLog[],
  allHttpLogs: HttpLog[],
  definition: DefinitionSnapshot | null,
  instanceItems: InstanceItemStatus[],
  screenshots: ArtifactRow[],
  storageDir: string,
): Promise<'back' | 'exit'> {
  const group = flatGroups[stepIndex];
  const step = group.steps[subStepIndex];
  const filePrefix = `${instance.name}-${stepLabel.toLowerCase().replace(/[ .]/g, '-')}`;
  // Derive step time window for filtering
  const timeWindow = getGroupTimeWindow(execLogs, stepIndex);

  // Fetch traffic for this step
  let stepHttpLogs: HttpLog[] = [];
  let stepDbLogs: DatabaseLog[] = [];

  if (step.action?.type === 'dbQuery') {
    const dbLogsRes = await fetchJson<DatabaseLogsResponse>(
      `${ctUrl}/logs/database/instance/${instance.id}?limit=500`,
    );
    const allDbLogs = dbLogsRes?.logs ? [...dbLogsRes.logs].reverse() : [];
    stepDbLogs = filterDbLogsByTimeWindow(allDbLogs, timeWindow).filter(
      (dl) => {
        if (!step.action!.database) {
          return true;
        }
        return dl.databaseName === step.action!.database;
      },
    );
  } else {
    stepHttpLogs = filterLogsByTimeWindow(allHttpLogs, execLogs, stepIndex);
  }

  let lastIndex = 0;
  while (true) {
    process.stdout.write('\x1b[2J\x1b[H');

    const menuItems: MenuItem<StepDetailAction>[] = [];

    // Show instance error message persistently across pages
    if (instance.errorMessage) {
      menuItems.push({
        label: `\x1b[31m${instance.errorMessage}\x1b[0m`,
        value: null as never,
        disabled: true,
      });
      menuItems.push({ label: '', value: null as never, disabled: true });
    }

    // Raw step definition
    menuItems.push({
      label: 'Raw Step Definition',
      value: { kind: 'raw-step' },
    });

    // Timeline — surfaced near the top because it's the primary debugging
    // view for any step that produces backend traffic. UI steps render the
    // full sub-step tree; HTTP/DB steps render just the call forest under
    // the step root. Skipped for `wait` (no traffic to correlate). Same
    // label for both flavours — content varies by step type.
    if (step.action?.type === 'ui') {
      menuItems.push({
        label: 'Timeline',
        value: { kind: 'ui-timeline' },
      });
    } else if (step.action?.type !== 'wait') {
      menuItems.push({
        label: 'Timeline',
        value: { kind: 'call-tree' },
      });
    }

    // Test logs scoped to this step group
    const stepExecLogs = execLogs.filter((l) => l.stepIndex === stepIndex);
    if (stepExecLogs.length > 0) {
      menuItems.push({
        label: `Test Logs \x1b[90m(${stepExecLogs.length})\x1b[0m`,
        value: { kind: 'test-logs' },
      });
    }

    // Screenshots scoped to this step
    if (screenshots.length > 0) {
      menuItems.push({
        label: `Screenshots \x1b[90m(${screenshots.length})\x1b[0m`,
        value: { kind: 'screenshots' },
      });
    }

    // Assertions
    const stepAssertions = assertionResults.filter(
      (a) => a.stepIndex === stepIndex,
    );
    if (stepAssertions.length > 0) {
      const failedCount = stepAssertions.filter((a) => !a.passed).length;
      const label =
        failedCount > 0
          ? `Assertions \x1b[31m(${failedCount} failed)\x1b[0m`
          : `Assertions \x1b[32m(all passed)\x1b[0m`;
      menuItems.push({ label, value: { kind: 'assertions' } });
    }

    // Variables
    const { before: varsBefore, after: varsAfter } = getGroupVariables(
      execLogs,
      stepIndex,
    );
    const beforeCount = Object.keys(varsBefore).length;
    const afterCount = Object.keys(varsAfter).length;
    if (beforeCount > 0 || afterCount > 0) {
      menuItems.push({ label: '', value: null as never, disabled: true });
      menuItems.push({
        label: '\x1b[90mVariables\x1b[0m',
        value: null as never,
        disabled: true,
      });
      if (beforeCount > 0) {
        menuItems.push({
          label: `Before \x1b[90m(${beforeCount})\x1b[0m`,
          value: { kind: 'variables-before' },
        });
      }
      if (afterCount > 0) {
        menuItems.push({
          label: `After \x1b[90m(${afterCount})\x1b[0m`,
          value: { kind: 'variables-after' },
        });
      }
    }

    // Traffic section
    if (stepHttpLogs.length > 0) {
      const hasOrigin = stepHttpLogs.some((l) => l.origin);
      menuItems.push({ label: '', value: null as never, disabled: true });
      menuItems.push({
        label: '\x1b[90mHTTP Traffic\x1b[0m',
        value: null as never,
        disabled: true,
      });
      for (let i = 0; i < stepHttpLogs.length; i++) {
        menuItems.push({
          label: formatLogLine(stepHttpLogs[i], hasOrigin),
          value: { kind: 'http-log', log: stepHttpLogs[i], index: i + 1 },
        });
      }
    }

    if (stepDbLogs.length > 0) {
      menuItems.push({ label: '', value: null as never, disabled: true });
      menuItems.push({
        label: '\x1b[90mDB Queries\x1b[0m',
        value: null as never,
        disabled: true,
      });
      for (let i = 0; i < stepDbLogs.length; i++) {
        menuItems.push({
          label: formatDbLogLine(stepDbLogs[i]),
          value: { kind: 'db-log', log: stepDbLogs[i], index: i + 1 },
        });
      }
    }

    // Console Logs section — list items from the definition
    const items = definition?.items ?? [];
    if (items.length > 0) {
      menuItems.push({ label: '', value: null as never, disabled: true });
      menuItems.push({
        label: '\x1b[90mConsole Logs\x1b[0m',
        value: null as never,
        disabled: true,
      });
      for (const item of items) {
        const ii = instanceItems.find(
          (i) => i.itemDefinitionName === item.name,
        );
        if (!ii) {
          continue;
        }
        const tag = item.type.toLowerCase();
        const color = itemTypeColor(item.type);
        menuItems.push({
          label: `${color}[${tag}]\x1b[0m ${item.name}`,
          value: {
            kind: 'console-log',
            itemName: item.name,
            instanceItemId: ii.id,
          },
        });
      }
    }

    const picked = await selectMenu(
      menuItems,
      `${instance.name} \u203a ${stepLabel}  ${instanceStatusBadge(instance)}`,
      { leftArrowBack: true, initialIndex: lastIndex },
    );
    if (!picked) {
      return 'back';
    }
    lastIndex = picked.index;

    switch (picked.value.kind) {
      case 'raw-step': {
        openInEditor(stripIds(step), `${filePrefix}-raw.json`);
        break;
      }
      case 'test-logs': {
        const stepExecLogs = execLogs.filter((l) => l.stepIndex === stepIndex);
        openInEditor(
          formatTestExecutionLogs(stepExecLogs),
          `${filePrefix}-test-logs.log`,
        );
        break;
      }
      case 'assertions': {
        const title = `${group.testName} \u203a ${stepLabel} \u203a Assertions`;
        // eslint-disable-next-line no-control-regex
        const ansiPattern = /\x1b\[[0-9;]*m/g;
        const content = formatAssertionReport(title, step, stepAssertions)
          .join('\n')
          .replace(ansiPattern, '');
        openInEditor(content, `${filePrefix}-assertions.log`);
        break;
      }
      case 'variables-before': {
        openInEditor(varsBefore, `${filePrefix}-variables-before.json`);
        break;
      }
      case 'variables-after': {
        openInEditor(varsAfter, `${filePrefix}-variables-after.json`);
        break;
      }
      case 'http-log': {
        openInEditor(
          formatHttpLog(picked.value.log),
          `${filePrefix}-http-log-${picked.value.index}.json`,
        );
        break;
      }
      case 'db-log': {
        openInEditor(
          formatDbLog(picked.value.log),
          `${filePrefix}-db-query-${picked.value.index}.json`,
        );
        break;
      }
      case 'console-log': {
        const consoleLogs = await fetchConsoleLogs(
          ctUrl,
          instance.id,
          picked.value.instanceItemId,
          timeWindow,
        );
        openInEditor(
          formatConsoleLogs(consoleLogs),
          `${filePrefix}-${picked.value.itemName}-console.log`,
        );
        break;
      }
      case 'ui-timeline': {
        // Fetch the full instance timeline, then narrow to just this step.
        // The server returns every UI sub-step event for the instance; we
        // filter by stepIndex so users see only the action they drilled into.
        const all = await fetchJson<UiTimelineEntry[]>(
          `${ctUrl}/logs/ui-timeline/instance/${instance.id}`,
        );
        const entries = (all ?? []).filter(
          (e) => e.stepIndex === group.globalIndex,
        );
        const title = `${group.testName} \u203a ${stepLabel} \u203a Timeline`;
        // Render the same timeline lines the scrollable view used, but strip
        // ANSI escapes so the on-disk file reads cleanly in any editor.
        // eslint-disable-next-line no-control-regex
        const ansiPattern = /\x1b\[[0-9;]*m/g;
        const content = formatUiTimeline(
          title,
          { stepLabel, stepName: step.name ?? '' },
          entries,
        )
          .join('\n')
          .replace(ansiPattern, '');
        openInEditor(content, `${filePrefix}-timeline.log`);
        break;
      }
      case 'call-tree': {
        // Non-UI step timeline: HTTP+DB call forest scoped to this step's
        // group window. Same nesting + step-root semantics as the UI flavour.
        const calls = await fetchJson<UiTimelineChild[]>(
          `${ctUrl}/logs/call-tree/instance/${instance.id}/step/${group.globalIndex}`,
        );
        const title = `${group.testName} › ${stepLabel} › Timeline`;
        // eslint-disable-next-line no-control-regex
        const ansiPattern = /\x1b\[[0-9;]*m/g;
        const content = formatStepCallTree(
          title,
          { stepLabel, stepName: step.name ?? '' },
          calls ?? [],
        )
          .join('\n')
          .replace(ansiPattern, '');
        openInEditor(content, `${filePrefix}-timeline.log`);
        break;
      }
      case 'screenshots': {
        const nav = await showStepScreenshots(
          instance,
          stepLabel,
          screenshots,
          storageDir,
        );
        if (nav === 'exit') {
          return 'exit';
        }
        break;
      }
    }
  }
}

async function fetchConsoleLogs(
  ctUrl: string,
  instanceId: string,
  instanceItemId: string,
  timeWindow: { start: string; end: string } | null,
): Promise<ConsoleLog[]> {
  const res = await fetchJson<ConsoleLogsResponse>(
    `${ctUrl}/logs/console/instance/${instanceId}?instanceItemId=${instanceItemId}&limit=1000`,
  );
  const logs = res?.logs ?? [];
  if (!timeWindow) {
    return logs;
  }

  const start = new Date(timeWindow.start).getTime();
  const end = new Date(timeWindow.end).getTime();

  return logs.filter((log) => {
    const t = new Date(log.timestamp).getTime();
    return t >= start && t <= end;
  });
}

async function showStepScreenshots(
  instance: InstanceSummary,
  stepLabel: string,
  screenshots: ArtifactRow[],
  storageDir: string,
): Promise<'back' | 'exit'> {
  let lastIndex = 0;
  while (true) {
    process.stdout.write('\x1b[2J\x1b[H');

    const menuItems: MenuItem<ArtifactRow>[] = screenshots.map((a) => ({
      label: a.name ?? `screenshot-${a.stepIndex}-${a.subStepIndex}`,
      value: a,
    }));

    const picked = await selectMenu(
      menuItems,
      `${instance.name} › ${stepLabel} › Screenshots`,
      { leftArrowBack: true, initialIndex: lastIndex },
    );
    if (!picked) {
      return 'back';
    }
    lastIndex = picked.index;

    openFile(resolveUri(picked.value.uri, storageDir));
  }
}
