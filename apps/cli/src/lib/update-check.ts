import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DOKKIMI_VERSION } from '@dokkimi/config';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day
const CHECK_FILE = path.join(os.homedir(), '.dokkimi', 'update-check.json');
const NPM_REGISTRY_URL = 'https://registry.npmjs.org/dokkimi/latest';
const FETCH_TIMEOUT_MS = 3000;

interface CheckState {
  lastCheck: number;
  latestVersion?: string;
}

function readCheckState(): CheckState | null {
  try {
    if (!fs.existsSync(CHECK_FILE)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(CHECK_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function writeCheckState(state: CheckState): void {
  try {
    const dir = path.dirname(CHECK_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CHECK_FILE, JSON.stringify(state));
  } catch {
    // Non-critical — skip silently
  }
}

function isNewer(remote: string, local: string): boolean {
  const rParts = remote.split('.').map(Number);
  const lParts = local.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const r = rParts[i] ?? 0;
    const l = lParts[i] ?? 0;
    if (r > l) {
      return true;
    }
    if (r < l) {
      return false;
    }
  }
  return false;
}

/**
 * Checks npm for a newer version of dokkimi (at most once per day).
 * Prints a yellow warning if a newer version is available.
 * Never blocks, never throws — failures are silent.
 */
export async function checkForUpdate(): Promise<void> {
  const state = readCheckState();

  // If we checked recently and have a cached result, use it
  if (state && Date.now() - state.lastCheck < CHECK_INTERVAL_MS) {
    if (state.latestVersion && isNewer(state.latestVersion, DOKKIMI_VERSION)) {
      printUpdateBanner(state.latestVersion, DOKKIMI_VERSION);
    }
    return;
  }

  // Fetch in background — don't block the command
  fetchLatestVersion()
    .then((latest) => {
      if (!latest) {
        writeCheckState({ lastCheck: Date.now() });
        return;
      }
      writeCheckState({ lastCheck: Date.now(), latestVersion: latest });
      if (isNewer(latest, DOKKIMI_VERSION)) {
        printUpdateBanner(latest, DOKKIMI_VERSION);
      }
    })
    .catch(() => {
      // Silent failure
    });
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(NPM_REGISTRY_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as Record<string, unknown>;
    const version = data.version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

function printUpdateBanner(latest: string, current: string): void {
  console.log(
    `\x1b[33mUpdate available: dokkimi v${latest} (you have v${current}). Run "npm install -g dokkimi" to update.\x1b[0m`,
  );
}
