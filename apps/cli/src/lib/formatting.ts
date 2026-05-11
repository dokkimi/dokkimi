import type {
  InstanceSummary,
  InstanceItemStatus,
  TestStep,
  AssertionResult,
  HttpLog,
  DatabaseLog,
} from './inspect-types';

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Truncate text to maxLen, adding ellipsis if needed, then pad to maxLen. */
export function fitText(text: string, maxLen: number): string {
  if (text.length > maxLen) {
    return text.slice(0, maxLen - 1) + '\u2026';
  }
  return text.padEnd(maxLen);
}

export function detailRow(label: string, value: string): string {
  return `\x1b[90m${label.padEnd(10)}\x1b[0m  ${value}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

export function statusColor(st: string): string {
  switch (st) {
    case 'PASSED':
    case 'COMPLETED':
      return '\x1b[32m';
    case 'FAILED':
      return '\x1b[31m';
    case 'SKIPPED':
    case 'NOT_VALIDATED':
      return '\x1b[90m';
    case 'PENDING':
      return '\x1b[90m';
    case 'RUNNING':
      return '\x1b[33m';
    default:
      return '\x1b[36m';
  }
}

export function statusCodeColor(code: number): string {
  if (code >= 500) {
    return '\x1b[31m';
  }
  if (code >= 400) {
    return '\x1b[33m';
  }
  if (code >= 300) {
    return '\x1b[36m';
  }
  return '\x1b[32m';
}

export function httpMethodColor(method: string): string {
  switch (method.toUpperCase()) {
    case 'GET':
      return '\x1b[34m';
    case 'POST':
      return '\x1b[32m';
    case 'PUT':
      return '\x1b[33m';
    case 'DELETE':
      return '\x1b[31m';
    case 'PATCH':
      return '\x1b[33m';
    case 'HEAD':
      return '\x1b[35m';
    case 'OPTIONS':
      return '\x1b[36m';
    default:
      return '\x1b[37m';
  }
}

// ---------------------------------------------------------------------------
// Badge / label formatters
// ---------------------------------------------------------------------------

export function statusBadge(status: string): string {
  return `${statusColor(status)}${status}\x1b[0m`;
}

export function instanceStatusBadge(inst: InstanceSummary): string {
  const st = inst.testStatus ?? inst.status;
  return `${statusColor(st)}${st}\x1b[0m`;
}

export function formatInstanceLabel(inst: InstanceSummary): string {
  const st = inst.testStatus ?? inst.status;
  return `${fitText(inst.name, 32)}  ${statusColor(st)}${st}\x1b[0m`;
}

export function describeAction(step: TestStep): string {
  if (!step.action) {
    return '(no action)';
  }
  if (step.action.type === 'httpRequest') {
    return `${step.action.method ?? '?'} ${step.action.url ?? ''}`;
  }
  if (step.action.type === 'dbQuery') {
    const q = step.action.query ?? '';
    return `${step.action.database ?? 'db'}: ${q.length > 40 ? q.slice(0, 40) + '...' : q}`;
  }
  return step.action.type ?? '(unknown action)';
}

export function formatAssertionLine(a: AssertionResult): string {
  const parts: string[] = [];
  if (a.assertionType) {
    parts.push(a.assertionType);
  }
  if (a.path) {
    parts.push(`\x1b[90m${a.path}\x1b[0m`);
  }
  if (a.operator) {
    parts.push(`\x1b[90m${a.operator}\x1b[0m`);
  }
  if (parts.length === 0) {
    return `assertion #${a.assertionIndex + 1}`;
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Log line formatters (for list/picker views)
// ---------------------------------------------------------------------------

export function formatLogLine(log: HttpLog, showOrigin: boolean): string {
  const termWidth = process.stdout.columns ?? 80;

  const originText = showOrigin
    ? (log.origin ? `[${log.origin}]` : '').padEnd(13)
    : '';
  const originLen = originText.length + (showOrigin ? 1 : 0); // +1 for trailing space
  const origin = showOrigin ? `\x1b[90m${originText}\x1b[0m ` : '';

  const methodText = (log.method ?? '?').padEnd(6);
  const method = `${httpMethodColor(log.method ?? '?')}${methodText}\x1b[0m`;

  const rawUrl = log.url ?? '';
  const endpoint = rawUrl.startsWith('http')
    ? rawUrl.replace(/^https?:\/\//, '')
    : `${log.target ?? ''}${rawUrl}`;

  const statusText = log.statusCode != null ? String(log.statusCode) : '---';
  const status =
    log.statusCode != null
      ? `${statusCodeColor(log.statusCode)}${statusText}\x1b[0m`
      : `\x1b[90m${statusText}\x1b[0m`;
  const durText =
    log.duration != null ? `(${formatDuration(log.duration)})` : '';
  const dur = durText ? `  \x1b[90m${durText}\x1b[0m` : '';
  const mockedText = log.isMocked ? '[mocked]' : '';
  const mocked = mockedText ? `  \x1b[35m${mockedText}\x1b[0m` : '';

  // 2 (menu cursor) + origin + method(6) + 1 (space) + endpoint + 1 (space) + arrow(1) + 1 (space) + status + dur + mocked
  const fixedLen =
    2 +
    originLen +
    6 +
    1 +
    1 +
    1 +
    1 +
    statusText.length +
    (durText ? 2 + durText.length : 0) +
    (mockedText ? 2 + mockedText.length : 0);
  const endpointCol = Math.max(15, termWidth - fixedLen);

  return `${origin}${method} ${fitText(endpoint, endpointCol)} \u2192 ${status}${dur}${mocked}`;
}

export function formatDbLogLine(dl: DatabaseLog): string {
  const termWidth = process.stdout.columns ?? 80;
  const status = dl.success
    ? '\x1b[32mSUCCESS\x1b[0m'
    : '\x1b[31mFAILED\x1b[0m';
  const statusLen = dl.success ? 7 : 6; // visible length of "SUCCESS" / "FAILED"
  const durText = dl.duration != null ? `(${formatDuration(dl.duration)})` : '';
  const dbName = fitText(dl.databaseName, 15);
  // 2 (menu cursor) + 15 (db name) + 1 (space) + query + 1 (space) + status + 2 (spaces) + dur
  const fixedLen =
    2 + 15 + 1 + 1 + statusLen + (durText ? 2 + durText.length : 0);
  const queryCol = Math.max(20, termWidth - fixedLen);
  const q = fitText(dl.query, queryCol);
  const dur = durText ? `  \x1b[90m${durText}\x1b[0m` : '';
  return `\x1b[36m${dbName}\x1b[0m ${q} ${status}${dur}`;
}

// ---------------------------------------------------------------------------
// Detail line builders (for scrollable detail views)
// ---------------------------------------------------------------------------

export function buildHttpDetailLines(log: HttpLog): string[] {
  const out: string[] = [];

  const method = log.method ?? '?';
  const rawUrl = log.url ?? '';
  const endpoint = rawUrl.startsWith('http')
    ? rawUrl.replace(/^https?:\/\//, '')
    : `${log.target ?? ''}${rawUrl}`;
  const status = log.statusCode ?? '---';
  const duration =
    log.duration != null ? formatDuration(log.duration) : '\u2014';
  const time = log.requestSentAt
    ? new Date(log.requestSentAt).toISOString()
    : '\u2014';

  out.push(
    `${httpMethodColor(method)}${method}\x1b[0m \x1b[1m${endpoint}\x1b[0m`,
  );
  out.push('');
  out.push(
    detailRow('Status', `${statusCodeColor(Number(status))}${status}\x1b[0m`),
  );
  out.push(
    detailRow(
      'Origin',
      log.origin ? `\x1b[36m${log.origin}\x1b[0m` : '\x1b[90m\u2014\x1b[0m',
    ),
  );
  out.push(
    detailRow(
      'Target',
      log.target ? `\x1b[36m${log.target}\x1b[0m` : '\x1b[90m\u2014\x1b[0m',
    ),
  );
  out.push(detailRow('Duration', `\x1b[33m${duration}\x1b[0m`));
  out.push(
    detailRow(
      'Mocked',
      log.isMocked ? '\x1b[35myes\x1b[0m' : '\x1b[90mno\x1b[0m',
    ),
  );
  out.push(detailRow('Time', `\x1b[90m${time}\x1b[0m`));

  if (log.requestHeaders && Object.keys(log.requestHeaders).length > 0) {
    out.push('', `\x1b[38;5;75m\x1b[1mRequest Headers\x1b[0m`);
    coloredJsonLines(log.requestHeaders).forEach((l) => out.push(l));
  }
  if (log.requestBody != null) {
    out.push('', `\x1b[38;5;75m\x1b[1mRequest Body\x1b[0m`);
    coloredJsonLines(log.requestBody).forEach((l) => out.push(l));
  }
  if (log.responseHeaders && Object.keys(log.responseHeaders).length > 0) {
    out.push('', `\x1b[38;5;75m\x1b[1mResponse Headers\x1b[0m`);
    coloredJsonLines(log.responseHeaders).forEach((l) => out.push(l));
  }
  if (log.responseBody != null) {
    out.push('', `\x1b[38;5;75m\x1b[1mResponse Body\x1b[0m`);
    coloredJsonLines(log.responseBody).forEach((l) => out.push(l));
  }

  return out;
}

export function buildDbDetailLines(dl: DatabaseLog): string[] {
  const out: string[] = [];
  out.push(`\x1b[38;5;75m\x1b[1mQuery Result\x1b[0m`);
  out.push('');
  out.push(
    detailRow(
      'Database',
      `\x1b[36m${dl.databaseName}\x1b[0m  \x1b[90m(${dl.databaseType})\x1b[0m`,
    ),
  );
  out.push(detailRow('Query', ''));
  out.push(`    \x1b[38;5;173m${dl.query}\x1b[0m`);
  out.push(
    detailRow(
      'Status',
      dl.success ? '\x1b[32mSUCCESS\x1b[0m' : '\x1b[31mFAILED\x1b[0m',
    ),
  );
  if (dl.duration != null) {
    out.push(
      detailRow('Duration', `\x1b[33m${formatDuration(dl.duration)}\x1b[0m`),
    );
  }
  if (dl.rowsAffected != null) {
    out.push(detailRow('Rows', `\x1b[32m${dl.rowsAffected}\x1b[0m`));
  }
  if (dl.error) {
    out.push('');
    out.push(`  \x1b[31m${dl.error}\x1b[0m`);
  }
  if (dl.data != null && dl.data.length > 0) {
    out.push('', `  \x1b[38;5;75m\x1b[1mData\x1b[0m`);
    coloredJsonLines(dl.data).forEach((l) => out.push(`  ${l}`));
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON syntax coloring
// ---------------------------------------------------------------------------

/**
 * Syntax-colored JSON output mimicking VSCode's dark theme.
 * Keys = cyan, strings = orange, numbers = green, booleans = blue, null = red,
 * {} = yellow, [] = purple.
 */
// ---------------------------------------------------------------------------
// Item type / status helpers
// ---------------------------------------------------------------------------

export function itemTypeColor(type: string): string {
  switch (type) {
    case 'SERVICE':
      return '\x1b[36m'; // cyan
    case 'DATABASE':
      return '\x1b[33m'; // yellow
    case 'MOCK':
      return '\x1b[32m'; // green
    default:
      return '\x1b[37m';
  }
}

export function itemStatusSuffix(
  itemName: string,
  instanceItems: InstanceItemStatus[],
): { text: string; len: number } {
  const ii = instanceItems.find((i) => i.itemDefinitionName === itemName);
  if (!ii) {
    return { text: '', len: 0 };
  }
  if (ii.status === 'CRASHED') {
    return { text: `  \x1b[31mFAILED\x1b[0m`, len: 8 };
  }
  if (ii.readinessStatus === 'NOT_READY') {
    return { text: `  \x1b[31mFAILED TO START\x1b[0m`, len: 17 };
  }
  return { text: '', len: 0 };
}

// ---------------------------------------------------------------------------
// JSON syntax coloring
// ---------------------------------------------------------------------------

export function coloredJsonLines(value: unknown): string[] {
  if (typeof value === 'string') {
    return [`  \x1b[38;5;173m${value}\x1b[0m`];
  }
  const raw = JSON.stringify(value, null, 2);
  // Color braces/brackets first using placeholders (before inserting escape
  // sequences that contain [ ] characters themselves).
  const withBraces = raw
    .replace(/[{}]/g, '\x00YEL$&\x00END')
    .replace(/[[\]]/g, '\x00PUR$&\x00END');
  const colored = withBraces
    .replace(/("(?:[^"\\]|\\.)*")\s*:/g, '\x1b[36m$1\x1b[0m:')
    .replace(/:\s*("(?:[^"\\]|\\.)*")/g, ': \x1b[38;5;173m$1\x1b[0m')
    .replace(/:\s*(-?\d+(?:\.\d+)?)(?=[,\n\r\x00])/g, ': \x1b[32m$1\x1b[0m')
    .replace(/:\s*(true|false)(?=[,\n\r\x00])/g, ': \x1b[34m$1\x1b[0m')
    .replace(/:\s*(null)(?=[,\n\r\x00])/g, ': \x1b[31m$1\x1b[0m')
    .replace(/\x00YEL/g, '\x1b[33m')
    .replace(/\x00PUR/g, '\x1b[35m')
    .replace(/\x00END/g, '\x1b[0m');
  return colored.split('\n').map((l) => `  ${l}`);
}
