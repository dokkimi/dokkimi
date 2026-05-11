import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openFile as platformOpenFile } from '@dokkimi/platform';
import type {
  HttpLog,
  DatabaseLog,
  ConsoleLog,
  TestExecutionLog,
} from './inspect-types';

const POD_LOG_SEPARATOR = '='.repeat(60);

// ---------------------------------------------------------------------------
// ID stripping
// ---------------------------------------------------------------------------

const STRIP_KEYS = new Set(['id', 'instanceId', 'instanceItemId']);

export function stripIds(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(stripIds);
  }
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!STRIP_KEYS.has(k)) {
        out[k] = stripIds(v);
      }
    }
    return out;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Log formatters (for editor output)
// ---------------------------------------------------------------------------

export function formatHttpLog(log: HttpLog): unknown {
  return {
    request: {
      method: log.method,
      url: log.url,
      origin: log.origin,
      target: log.target,
      headers: log.requestHeaders,
      body: log.requestBody,
      sentAt: log.requestSentAt,
    },
    response: {
      statusCode: log.statusCode,
      headers: log.responseHeaders,
      body: log.responseBody,
      receivedAt: log.responseReceivedAt,
    },
    duration: log.duration,
    isMocked: log.isMocked,
  };
}

export function formatDbLog(log: DatabaseLog): unknown {
  return {
    database: log.databaseName,
    databaseType: log.databaseType,
    query: log.query,
    params: log.params,
    success: log.success,
    data: log.data,
    rowsAffected: log.rowsAffected,
    error: log.error,
    duration: log.duration,
    timestamp: log.timestamp,
  };
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function formatTestExecutionLogs(logs: TestExecutionLog[]): string {
  if (logs.length === 0) {
    return '(no test execution logs)\n';
  }
  return (
    logs
      .map((log) => {
        const step = log.stepIndex !== null ? ` [step ${log.stepIndex}]` : '';
        const subAction =
          log.subActionIndex !== null
            ? ` [subAction ${log.subActionIndex}]`
            : '';
        const dur = log.duration !== null ? ` (${log.duration}ms)` : '';
        const err = log.error ? `\n  error: ${log.error}` : '';
        return `${log.timestamp} ${log.eventType}${step}${subAction}${dur}\n  ${log.message}${err}`;
      })
      .join('\n\n') + '\n'
  );
}

export function formatConsoleLogs(logs: ConsoleLog[]): string {
  if (logs.length === 0) {
    return '(no console logs)\n';
  }
  return (
    logs
      .map(
        (log) =>
          `${log.timestamp} [${log.level.padEnd(5)}]  ${log.message.replace(ANSI_RE, '')}`,
      )
      .join('\n') + '\n'
  );
}

export function formatPodLogs(
  logs: TestExecutionLog[],
  itemName: string,
): string {
  if (logs.length === 0) {
    return `(no pod logs captured for ${itemName})\n`;
  }
  return logs
    .map((log) => {
      // Strip the [item:...] prefix — keep [pod:...] and [container:...] and the rest
      return log.message.replace(/^\[item:[^\]]+\]\s*/, '');
    })
    .join('\n' + POD_LOG_SEPARATOR + '\n\n');
}

// ---------------------------------------------------------------------------
// Open in editor
// ---------------------------------------------------------------------------

export function openInEditor(data: unknown, filename: string): void {
  const tmpDir = path.join(os.tmpdir(), 'dokkimi-inspect');
  fs.mkdirSync(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, filename);
  const content =
    typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  fs.writeFileSync(filePath, content);
  openFile(filePath);
}

export function openFile(filePath: string): void {
  platformOpenFile(filePath);
}
