import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DOKKIMI_VERSION } from '@dokkimi/config';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day
const CHECK_FILE = path.join(os.homedir(), '.dokkimi', 'update-check.json');
const NPM_REGISTRY_URL = 'https://registry.npmjs.org/dokkimi/latest';
const FETCH_TIMEOUT_MS = 3000;
const RELEASE_NOTES_URL = 'https://dokkimi.com/docs/release-notes';

interface CheckState {
  lastCheck: number;
  latestVersion?: string;
}

export interface UpdateStatus {
  currentVersion: string;
  updateAvailable: boolean;
  latestVersion?: string;
  updateCommand?: string;
  releaseNotesUrl?: string;
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
 * Homebrew installs the package under .../Cellar/dokkimi/<version>/libexec,
 * so the real path of the running script identifies the install method.
 */
export function getUpdateCommand(): string {
  try {
    const realPath = fs.realpathSync(process.argv[1] ?? '');
    if (realPath.split(path.sep).includes('Cellar')) {
      return 'brew upgrade dokkimi';
    }
  } catch {
    // Fall through to npm
  }
  return 'npm install -g dokkimi';
}

function isCacheStale(state: CheckState | null): boolean {
  return state === null || Date.now() - state.lastCheck >= CHECK_INTERVAL_MS;
}

// Fire-and-forget cache refresh. A failed fetch still advances lastCheck
// (rate-limiting retries to once per day) and keeps the last known version.
function refreshCacheInBackground(knownVersion?: string): void {
  fetchLatestVersion()
    .then((latest) => {
      const version = latest ?? knownVersion;
      writeCheckState({
        lastCheck: Date.now(),
        ...(version ? { latestVersion: version } : {}),
      });
    })
    .catch(() => {
      // Silent failure
    });
}

/**
 * Prints a yellow banner when the daily cache knows about a newer version
 * (even a stale cache — the version it holds is still the best answer),
 * then refreshes a stale cache in the background.
 * Never blocks, never throws — failures are silent.
 */
export function checkForUpdate(): void {
  const state = readCheckState();

  if (state?.latestVersion && isNewer(state.latestVersion, DOKKIMI_VERSION)) {
    printUpdateBanner(state.latestVersion);
  }

  if (isCacheStale(state)) {
    refreshCacheInBackground(state?.latestVersion);
  }
}

/**
 * Resolves the current update status for status/doctor surfaces from the
 * daily cache. Only forceFetch (doctor) hits the registry and blocks;
 * otherwise a stale cache just triggers the background refresh.
 */
export async function getUpdateStatus(
  options: { forceFetch?: boolean } = {},
): Promise<UpdateStatus> {
  const state = readCheckState();

  let latest = state?.latestVersion;
  if (options.forceFetch) {
    const fetched = await fetchLatestVersion();
    if (fetched) {
      latest = fetched;
    }
    // Written even on failure so an unreachable registry is retried at most
    // once per day instead of stalling every command.
    writeCheckState({
      lastCheck: Date.now(),
      ...(latest ? { latestVersion: latest } : {}),
    });
  } else if (isCacheStale(state)) {
    refreshCacheInBackground(state?.latestVersion);
  }

  if (latest && isNewer(latest, DOKKIMI_VERSION)) {
    return {
      currentVersion: DOKKIMI_VERSION,
      updateAvailable: true,
      latestVersion: latest,
      updateCommand: getUpdateCommand(),
      releaseNotesUrl: RELEASE_NOTES_URL,
    };
  }
  return { currentVersion: DOKKIMI_VERSION, updateAvailable: false };
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

function printUpdateBanner(latest: string): void {
  console.log(
    `\x1b[33mUpdate available: dokkimi v${latest} (you have v${DOKKIMI_VERSION}). Run "${getUpdateCommand()}" to update.\x1b[0m\n` +
      `\x1b[90mRelease notes: ${RELEASE_NOTES_URL}\x1b[0m`,
  );
}
