import * as path from 'path';
import * as readline from 'readline';

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

export const TIMEOUT_HEALTH = 3000;
export const TIMEOUT_FETCH = 5000;
export const TIMEOUT_ACTION = 10000;

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export const PAD_STATUS = 12;
export const PAD_NAME = 30;
export const PAD_LABEL = 20;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export function prompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.resolve('');
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

export async function fetchJson<T>(
  url: string,
  timeoutMs = TIMEOUT_FETCH,
): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchAction(
  url: string,
  method: 'POST' | 'DELETE',
  timeoutMs = TIMEOUT_ACTION,
): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchPost<T>(
  url: string,
  body: unknown,
  timeoutMs = TIMEOUT_ACTION,
): Promise<T | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export type FetchPostResult<T> =
  | { data: T; error?: never }
  | { data?: never; error: string };

export async function fetchPostWithError<T>(
  url: string,
  body: unknown,
  timeoutMs = TIMEOUT_ACTION,
): Promise<FetchPostResult<T>> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      return { data: (await res.json()) as T };
    }
    // Try to extract error message from response body
    let detail: string;
    try {
      const errBody = (await res.json()) as Record<string, unknown>;
      detail = (errBody.message ||
        errBody.error ||
        JSON.stringify(errBody)) as string;
    } catch {
      detail = `HTTP ${res.status}`;
    }
    return { error: detail };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return { error: 'Request timed out — service may not be running' };
    }
    return { error: err instanceof Error ? err.message : 'Connection failed' };
  }
}

// ---------------------------------------------------------------------------
// Service health
// ---------------------------------------------------------------------------

export interface ServiceCheck {
  name: string;
  url: string;
  healthy: boolean;
  detail?: string;
}

export async function checkService(
  name: string,
  url: string,
): Promise<ServiceCheck> {
  try {
    const res = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(TIMEOUT_HEALTH),
    });
    if (res.ok) {
      return { name, url, healthy: true };
    }
    return { name, url, healthy: false, detail: `HTTP ${res.status}` };
  } catch {
    return { name, url, healthy: false, detail: 'not reachable' };
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatUptime(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

export function formatAge(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  if (isNaN(ms)) {
    return 'unknown';
  }
  return formatUptime(Math.floor(ms / 1000)) + ' ago';
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveUri(uri: string, storageDir: string): string {
  return path.isAbsolute(uri) ? uri : path.join(storageDir, uri);
}

// ---------------------------------------------------------------------------
// Shared instance types
// ---------------------------------------------------------------------------

export const ACTIVE_STATUSES = [
  'PENDING',
  'STARTING',
  'RUNNING',
  'STOPPING',
  'TERMINATING',
];
export const TERMINAL_STATUSES = ['STOPPED', 'FAILED'];

export interface Instance {
  id: string;
  definition?: { id: string; name: string; description?: string };
  status: string;
  runNumber: number;
  createdAt: string;
  itemCount?: number;
}
