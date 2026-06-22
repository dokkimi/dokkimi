import type {
  DatabaseLog,
  TestExecutionLog,
  TestStep,
  AssertionResult,
} from '../lib/inspect-types';

export function filterDbLogsByTimeWindow(
  dbLogs: DatabaseLog[],
  timeWindow: { start: string; end: string } | null,
): DatabaseLog[] {
  if (!timeWindow) {
    return [];
  }
  const start = new Date(timeWindow.start).getTime();
  const end = new Date(timeWindow.end).getTime();
  return dbLogs.filter((dl) => {
    const t = new Date(dl.timestamp).getTime();
    return t >= start && t <= end;
  });
}

export function getGroupTimeWindow(
  execLogs: TestExecutionLog[],
  stepIndex: number,
): { start: string; end: string } | null {
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
    return null;
  }
  return { start: startTime, end: endTime ?? new Date().toISOString() };
}

export function formatAssertionReport(
  title: string,
  step: TestStep,
  assertions: AssertionResult[],
): string[] {
  const lines: string[] = [];
  const GREEN = '\x1b[32m';
  const RED = '\x1b[31m';
  const DIM = '\x1b[90m';
  const RESET = '\x1b[0m';
  const BOLD = '\x1b[1m';

  lines.push(`  ${BOLD}${title}${RESET}`);
  lines.push('');

  const passedCount = assertions.filter((a) => a.passed).length;
  const failedCount = assertions.length - passedCount;
  const summaryParts = [`${GREEN}${passedCount} passed${RESET}`];
  if (failedCount > 0) {
    summaryParts.push(`${RED}${failedCount} failed${RESET}`);
  }
  lines.push(`  ${summaryParts.join('  ')}`);

  const blocks =
    (step.assertions as Array<Record<string, unknown>> | undefined) ?? [];
  const byBlock = new Map<number, AssertionResult[]>();
  for (const a of assertions) {
    const idx = a.blockIndex ?? -1;
    const list = byBlock.get(idx) ?? [];
    list.push(a);
    byBlock.set(idx, list);
  }
  const blockIndices = [...byBlock.keys()].sort((a, b) => a - b);

  for (const idx of blockIndices) {
    const block = idx >= 0 ? blocks[idx] : undefined;
    const blockResults = byBlock.get(idx) ?? [];
    const header = formatBlockHeader(block, blockResults[0]?.assertionType);
    lines.push('');
    lines.push(`  ${DIM}── ${header} ──${RESET}`);
    lines.push('');
    for (const a of blockResults) {
      lines.push(...formatAssertionLine(a, block, GREEN, RED, DIM, RESET));
    }
  }

  return lines;
}

function formatBlockHeader(
  block: Record<string, unknown> | undefined,
  fallbackType: string | undefined,
): string {
  if (!block) {
    if (fallbackType === 'consoleLog') {
      return 'Console logs';
    }
    if (fallbackType === 'httpCall') {
      return 'HTTP calls';
    }
    return 'Step result';
  }

  if (typeof block.service === 'string') {
    return `Console logs from ${block.service}`;
  }

  const match = block.match as Record<string, unknown> | undefined;
  if (match) {
    const method = typeof match.method === 'string' ? match.method : '';
    const url = typeof match.url === 'string' ? match.url : '';
    const origin = typeof match.origin === 'string' ? `${match.origin} → ` : '';
    const tag = block.count ? '  [count]' : '';
    const target = [method, url].filter(Boolean).join(' ');
    return `HTTP calls: ${origin}${target}${tag}`.trim();
  }

  return 'Step result';
}

function formatAssertionLine(
  a: AssertionResult,
  block: Record<string, unknown> | undefined,
  GREEN: string,
  RED: string,
  DIM: string,
  RESET: string,
): string[] {
  const lines: string[] = [];
  const icon = a.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;

  let summary: string;
  if (a.resultKind === 'count' && !a.path) {
    const count = block?.count as
      | { operator?: string; value?: unknown }
      | undefined;
    const op = count?.operator ?? a.operator ?? '';
    const val = count?.value !== undefined ? JSON.stringify(count.value) : '';
    summary = `count ${op} ${val}`.trim();
  } else if (a.resultKind === 'extract') {
    summary = a.path ? `extract → ${a.path}` : 'extract';
  } else {
    const pathStr = a.path || '';
    const opStr = a.operator ? ` ${a.operator}` : '';
    const valStr =
      a.expected !== null && a.expected !== undefined
        ? ` ${JSON.stringify(a.expected)}`
        : '';
    summary = `${pathStr}${opStr}${valStr}`.trim();
  }

  lines.push(`  ${icon} ${summary}`);

  if (!a.passed) {
    if (a.expected !== null && a.expected !== undefined) {
      lines.push(
        `      ${DIM}expected:${RESET} ${GREEN}${JSON.stringify(a.expected)}${RESET}`,
      );
    }
    if (a.actual !== null && a.actual !== undefined) {
      lines.push(
        `      ${DIM}  actual:${RESET} ${RED}${JSON.stringify(a.actual)}${RESET}`,
      );
    }
    if (a.error) {
      lines.push(`      ${DIM}   error:${RESET} ${RED}${a.error}${RESET}`);
    }
  }

  return lines;
}
