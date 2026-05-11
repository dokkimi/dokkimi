import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const PREFS_FILE = path.join(os.homedir(), '.dokkimi', 'config.json');

export interface TelemetryPrefs {
  distinctId: string;
  enabled: boolean;
  firstRunNoticeSeen: boolean;
}

export interface KubeconfigPrefs {
  context?: string;
}

export interface ConcurrencyPrefs {
  maxNamespaces?: number;
  maxBooting?: number;
}

export interface UserPrefs {
  telemetry?: TelemetryPrefs;
  kubeconfig?: KubeconfigPrefs;
  concurrency?: ConcurrencyPrefs;
}

export function getUserPrefs(): UserPrefs {
  try {
    if (!fs.existsSync(PREFS_FILE)) {
      return {};
    }
    const raw = fs.readFileSync(PREFS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    return parsed as UserPrefs;
  } catch {
    return {};
  }
}

export function writeUserPrefs(prefs: UserPrefs): void {
  try {
    const dir = path.dirname(PREFS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2) + '\n');
  } catch {
    // Non-critical — skip silently
  }
}

export function updateUserPrefs(
  updater: (prefs: UserPrefs) => UserPrefs,
): UserPrefs {
  const current = getUserPrefs();
  const updated = updater(current);
  writeUserPrefs(updated);
  return updated;
}

export function getTelemetryPrefs(): TelemetryPrefs | undefined {
  return getUserPrefs().telemetry;
}

export function setTelemetryPrefs(telemetry: TelemetryPrefs): void {
  updateUserPrefs((prefs) => ({ ...prefs, telemetry }));
}

export function getKubeconfigPrefs(): KubeconfigPrefs {
  return getUserPrefs().kubeconfig ?? {};
}

export function setKubeconfigPrefs(kubeconfig: KubeconfigPrefs): void {
  updateUserPrefs((prefs) => {
    if (!kubeconfig.context) {
      const { kubeconfig: _, ...rest } = prefs;
      return rest;
    }
    return { ...prefs, kubeconfig };
  });
}

export function getConcurrencyPrefs(): ConcurrencyPrefs {
  return getUserPrefs().concurrency ?? {};
}

export function setConcurrencyPrefs(concurrency: ConcurrencyPrefs): void {
  updateUserPrefs((prefs) => {
    const cleaned = { ...concurrency };
    if (cleaned.maxNamespaces === undefined) {
      delete cleaned.maxNamespaces;
    }
    if (cleaned.maxBooting === undefined) {
      delete cleaned.maxBooting;
    }
    if (Object.keys(cleaned).length === 0) {
      const { concurrency: _, ...rest } = prefs;
      return rest;
    }
    return { ...prefs, concurrency: cleaned };
  });
}
