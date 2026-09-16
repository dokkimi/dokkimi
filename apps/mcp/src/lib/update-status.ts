import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DOKKIMI_VERSION } from '@dokkimi/config';

export interface AvailableUpdate {
  currentVersion: string;
  latestVersion: string;
  updateCommand: string;
  releaseNotesUrl: string;
}

const CHECK_FILE = path.join(os.homedir(), '.dokkimi', 'update-check.json');
const RELEASE_NOTES_URL = 'https://dokkimi.com/docs/release-notes';

// Keep in sync with apps/cli/src/lib/update-check.ts (the apps can't share
// code — the CLI depends on this package, so importing it back would cycle).
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

function getUpdateCommand(): string {
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

/**
 * Returns update info when the CLI's daily update cache holds a newer
 * version, null otherwise (including on any failure). Purely a local file
 * read — never spawns a process or touches the network; the CLI commands
 * own refreshing the cache.
 */
export function getAvailableUpdate(): AvailableUpdate | null {
  try {
    const state = JSON.parse(fs.readFileSync(CHECK_FILE, 'utf-8')) as {
      latestVersion?: unknown;
    };
    const latest = state?.latestVersion;
    if (typeof latest === 'string' && isNewer(latest, DOKKIMI_VERSION)) {
      return {
        currentVersion: DOKKIMI_VERSION,
        latestVersion: latest,
        updateCommand: getUpdateCommand(),
        releaseNotesUrl: RELEASE_NOTES_URL,
      };
    }
  } catch {
    // Missing or corrupt cache — no update info
  }
  return null;
}
