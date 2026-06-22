import type { MenuItem } from './menu';
import type {
  DefinitionSnapshot,
  DefinitionSnapshotItem,
  InstanceSummary,
  InstanceItemStatus,
  TestExecutionLog,
  AssertionResult,
  HttpLog,
  FlatStepGroup,
} from './inspect-types';
import { fitText } from './formatting';
import { itemTypeColor, itemStatusSuffix } from './formatting';

// ---------------------------------------------------------------------------
// Instance menu action type
// ---------------------------------------------------------------------------

export type InstanceMenuAction =
  | { kind: 'raw' }
  | { kind: 'test-logs' }
  | { kind: 'screenshots' }
  | { kind: 'item'; item: DefinitionSnapshotItem }
  | { kind: 'suite'; suiteIndex: number }
  | { kind: 'traffic-log'; log: HttpLog };

// ---------------------------------------------------------------------------
// Instance menu builder
// ---------------------------------------------------------------------------

export function buildInstanceMenuItems(
  definition: DefinitionSnapshot | null,
  instance: InstanceSummary,
  instanceItems: InstanceItemStatus[],
  sectionItems: MenuItem<InstanceMenuAction>[],
  sectionLabel = 'Tests',
  hasScreenshots = false,
): MenuItem<InstanceMenuAction>[] {
  const items = definition?.items ?? [];
  const hasTests = sectionLabel === 'Tests';
  const menuItems: MenuItem<InstanceMenuAction>[] = [];

  // Error message
  if (instance.errorMessage) {
    menuItems.push({
      label: `\x1b[31m${instance.errorMessage}\x1b[0m`,
      value: null as never,
      disabled: true,
    });
    menuItems.push({ label: '', value: null as never, disabled: true });
  }

  // Raw definition
  if (definition) {
    menuItems.push({ label: 'Raw Definition', value: { kind: 'raw' } });
    if (hasTests) {
      menuItems.push({ label: 'Test Logs', value: { kind: 'test-logs' } });
    }
    if (hasScreenshots) {
      menuItems.push({ label: 'Screenshots', value: { kind: 'screenshots' } });
    }
  }

  // Items (flat list)
  if (items.length > 0) {
    const termWidth = process.stdout.columns ?? 80;
    const maxTagLen = Math.max(...items.map((i) => i.type.length));

    menuItems.push({ label: '', value: null as never, disabled: true });
    menuItems.push({
      label: '\x1b[90mItems\x1b[0m',
      value: null as never,
      disabled: true,
    });
    for (const item of items) {
      const tag = item.type.toLowerCase();
      const color = itemTypeColor(item.type);
      const paddedTag = `[${tag}]`.padEnd(maxTagLen + 2);
      const { text: suffix, len: suffixLen } = itemStatusSuffix(
        item.name,
        instanceItems,
      );
      // 2 = menu cursor prefix
      const visiblePrefix = paddedTag.length + 1; // tag + space
      const nameCol = termWidth - 2 - visiblePrefix - suffixLen;
      menuItems.push({
        label: `${color}${paddedTag}\x1b[0m ${fitText(item.name, Math.max(10, nameCol))}${suffix}`,
        value: { kind: 'item', item },
      });
    }
  }

  // Test steps
  if (sectionItems.length > 0) {
    menuItems.push({ label: '', value: null as never, disabled: true });
    menuItems.push({
      label: `\x1b[90m${sectionLabel}\x1b[0m`,
      value: null as never,
      disabled: true,
    });
    menuItems.push(...sectionItems);
  }

  return menuItems;
}

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

export function deriveGroupStatuses(
  execLogs: TestExecutionLog[],
  groupCount: number,
): Map<number, string> {
  const statuses = new Map<string, string>();

  for (const log of execLogs) {
    if (log.stepIndex === null) {
      continue;
    }
    switch (log.eventType) {
      case 'STEP_STARTED':
        statuses.set(String(log.stepIndex), 'RUNNING');
        break;
      case 'STEP_COMPLETED':
        statuses.set(String(log.stepIndex), 'PASSED');
        break;
      case 'STEP_FAILED':
        statuses.set(String(log.stepIndex), 'FAILED');
        break;
      case 'REQUEST_SKIPPED':
        statuses.set(String(log.stepIndex), 'SKIPPED');
        break;
    }
  }

  const result = new Map<number, string>();
  for (let i = 0; i < groupCount; i++) {
    result.set(i, statuses.get(String(i)) ?? 'PENDING');
  }
  return result;
}

export function deriveStepAssertionStatuses(
  assertions: AssertionResult[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const a of assertions) {
    const key = `${a.stepIndex}`;
    if (a.resultKind === 'SKIPPED' || a.resultKind === 'NOT_VALIDATED') {
      if (!map.has(key)) {
        map.set(key, a.resultKind);
      }
    } else if (!a.passed) {
      map.set(key, 'FAILED');
    } else if (!map.has(key)) {
      map.set(key, 'PASSED');
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Error message helpers
// ---------------------------------------------------------------------------

/**
 * Rewrite "step group N failed: ..." to reference the test name and step
 * within the test, so the user sees something meaningful instead of a
 * global group index they can't correlate to the UI.
 */
export function rewriteErrorMessage(
  errorMessage: string,
  flatGroups: FlatStepGroup[],
): string {
  return errorMessage.replace(
    /step (?:group )?(\d+) failed/i,
    (_match, numStr) => {
      const globalIndex = parseInt(numStr, 10) - 1; // error uses 1-based
      const group = flatGroups[globalIndex];
      if (!group) {
        return _match;
      }

      const stepName = group.steps[0]?.name;
      const label = stepName
        ? `"${group.testName}" failed at "${stepName}"`
        : `"${group.testName}" failed`;
      return label;
    },
  );
}

/**
 * Get the error message from execution logs for a specific group index.
 */
export function getGroupError(
  execLogs: TestExecutionLog[],
  stepIndex: number,
): string | null {
  for (const log of execLogs) {
    if (log.stepIndex === stepIndex && log.eventType === 'STEP_FAILED') {
      return log.error ?? log.message ?? null;
    }
  }
  return null;
}

/**
 * Get the variable snapshots before and after a step's execution.
 * "before" = snapshot from the previous step's completion (or initial state).
 * "after"  = snapshot from this step's completion/failure.
 */
export function getGroupVariables(
  execLogs: TestExecutionLog[],
  stepIndex: number,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  let before: Record<string, unknown> = {};
  let after: Record<string, unknown> = {};

  for (const log of execLogs) {
    const isStepEnd =
      log.eventType === 'STEP_COMPLETED' || log.eventType === 'STEP_FAILED';
    if (!isStepEnd || log.stepIndex === null) {
      continue;
    }

    if (log.stepIndex < stepIndex) {
      before = log.variables ?? {};
    } else if (log.stepIndex === stepIndex) {
      after = log.variables ?? {};
    }
  }

  return { before, after };
}

// ---------------------------------------------------------------------------
// Log filtering
// ---------------------------------------------------------------------------

/**
 * Filter HTTP logs by the time window of a step's execution.
 * Uses STEP_STARTED / STEP_COMPLETED timestamps from execution logs
 * to capture ALL inter-service traffic during the step.
 */
export function filterLogsByTimeWindow(
  httpLogs: HttpLog[],
  execLogs: TestExecutionLog[],
  stepIndex: number,
): HttpLog[] {
  let startTime: string | null = null;
  let endTime: string | null = null;

  for (const log of execLogs) {
    if (log.stepIndex !== stepIndex) {
      continue;
    }
    if (log.eventType === 'STEP_STARTED') {
      startTime = log.timestamp;
    } else if (
      log.eventType === 'STEP_COMPLETED' ||
      log.eventType === 'STEP_FAILED'
    ) {
      endTime = log.timestamp;
    }
  }

  if (!startTime) {
    return [];
  }

  const start = new Date(startTime).getTime();
  const end = endTime ? new Date(endTime).getTime() : Date.now();

  return httpLogs.filter((log) => {
    const logTime = log.requestSentAt
      ? new Date(log.requestSentAt).getTime()
      : null;
    if (logTime === null) {
      return false;
    }
    return logTime >= start && logTime <= end;
  });
}
