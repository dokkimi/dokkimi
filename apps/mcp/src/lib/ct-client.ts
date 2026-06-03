import { loadConfig, buildServiceUrl } from '@dokkimi/config';

let cachedCtUrl: string | null = null;

function getCtUrl(): string {
  if (!cachedCtUrl) {
    const config = loadConfig();
    cachedCtUrl = buildServiceUrl(config.services.controlTower);
  }
  return cachedCtUrl;
}

export async function ctFetch<T>(
  path: string,
  params?: Record<string, string | undefined>,
): Promise<T> {
  const base = getCtUrl();
  // Use string concat rather than new URL(path, base) — the latter discards
  // any base path when `path` starts with '/'.
  const url = new URL(`${base.replace(/\/$/, '')}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    }
  }

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      throw new Error(
        'Control Tower is not running. Start Dokkimi with `dokkimi status` first.',
        { cause: err },
      );
    }
    if (msg.includes('timed out') || msg.includes('TimeoutError')) {
      throw new Error('Control Tower request timed out.', { cause: err });
    }
    throw new Error(`Control Tower request failed: ${msg}`, { cause: err });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Control Tower returned ${res.status}: ${body || res.statusText}`,
    );
  }

  return (await res.json()) as T;
}

export async function ctFetchOrNull<T>(
  path: string,
  params?: Record<string, string | undefined>,
): Promise<T | null> {
  try {
    return await ctFetch<T>(path, params);
  } catch (err) {
    // Only swallow "not running" / timeout errors — propagate server errors
    // so callers don't confuse a 500 with "no data."
    const msg = err instanceof Error ? err.message : '';
    if (
      msg.includes('not running') ||
      msg.includes('timed out') ||
      msg.includes('request failed')
    ) {
      return null;
    }
    throw err;
  }
}
