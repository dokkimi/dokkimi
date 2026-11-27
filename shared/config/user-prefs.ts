import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const PREFS_FILE = path.join(os.homedir(), '.dokkimi', 'config.json');

export function prefsFilePath(): string {
  return PREFS_FILE;
}

export interface TelemetryPrefs {
  distinctId: string;
  enabled: boolean;
  firstRunNoticeSeen: boolean;
}

export interface ConcurrencyPrefs {
  maxConcurrentTests?: number;
  maxBootingTests?: number;
}

export interface ProjectPrefs {
  maxRunHistory?: number;
  concurrency?: ConcurrencyPrefs;
}

export interface UserPrefs {
  telemetry?: TelemetryPrefs;
  concurrency?: ConcurrencyPrefs;
  maxRunHistory?: number;
  projects?: Record<string, ProjectPrefs>;
}

/**
 * The prefs file. broken: it exists but can't be read as JSON (e.g. a typo
 * after a hand edit). It is then never written, so that a fix by hand loses
 * nothing, and telemetry is off.
 */
function readPrefsFile(): { prefs: UserPrefs; broken: boolean } {
  let raw: string;
  try {
    raw = fs.readFileSync(PREFS_FILE, 'utf-8');
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    return { prefs: {}, broken: !missing };
  }
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return { prefs: parsed as UserPrefs, broken: false };
    }
  } catch {}
  return { prefs: {}, broken: true };
}

export function getUserPrefs(): UserPrefs {
  return readPrefsFile().prefs;
}

/** Writes the prefs file atomically. Throws when it can't be read or written. */
export function writeUserPrefs(prefs: UserPrefs): void {
  if (readPrefsFile().broken) {
    throw new Error(
      `${PREFS_FILE} can't be read, so settings aren't saved. Fix or delete it.`,
    );
  }
  fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
  const tmp = `${PREFS_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2) + '\n');
    fs.renameSync(tmp, PREFS_FILE);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export function updateUserPrefs(
  updater: (prefs: UserPrefs) => UserPrefs,
): UserPrefs {
  const updated = updater(getUserPrefs());
  writeUserPrefs(updated);
  return updated;
}

export function getTelemetryPrefs(): TelemetryPrefs | undefined {
  const { prefs, broken } = readPrefsFile();
  if (broken) {
    // Whether the user opted out is unknown: assume they did
    return { distinctId: '', enabled: false, firstRunNoticeSeen: true };
  }
  return prefs.telemetry;
}

export function setTelemetryPrefs(telemetry: TelemetryPrefs): void {
  updateUserPrefs((prefs) => ({ ...prefs, telemetry }));
}

export function getConcurrencyPrefs(projectPath?: string): ConcurrencyPrefs {
  const prefs = getUserPrefs();
  const global = prefs.concurrency ?? {};
  if (projectPath) {
    const project = prefs.projects?.[projectPath]?.concurrency ?? {};
    return {
      maxConcurrentTests:
        project.maxConcurrentTests ?? global.maxConcurrentTests,
      maxBootingTests: project.maxBootingTests ?? global.maxBootingTests,
    };
  }
  return global;
}

export interface Concurrency {
  maxConcurrentTests: number;
  maxBootingTests: number;
}

/**
 * The concurrency Control Tower runs with: an environment variable wins, then
 * the saved setting (`dokkimi config`), then the config file. `config` is the
 * loaded config, which has the environment variables applied. Before, a saved
 * setting won over the variables, so CI's DOKKIMI_MAX_* could be ignored.
 */
export function resolveConcurrency(config: {
  concurrency: Concurrency;
}): Concurrency {
  const saved = getConcurrencyPrefs();
  const { maxConcurrentTests, maxBootingTests } = config.concurrency;
  return {
    maxConcurrentTests: process.env.DOKKIMI_MAX_CONCURRENT_NAMESPACES
      ? maxConcurrentTests
      : (saved.maxConcurrentTests ?? maxConcurrentTests),
    maxBootingTests: process.env.DOKKIMI_MAX_BOOTING_NAMESPACES
      ? maxBootingTests
      : (saved.maxBootingTests ?? maxBootingTests),
  };
}

/** How a running Control Tower's concurrency differs from the wanted one, or null */
export function concurrencyDifference(
  running: Concurrency,
  wanted: Concurrency,
): string | null {
  if (
    running.maxConcurrentTests === wanted.maxConcurrentTests &&
    running.maxBootingTests === wanted.maxBootingTests
  ) {
    return null;
  }
  const show = (c: Concurrency) =>
    `${c.maxConcurrentTests} parallel, ${c.maxBootingTests} booting`;
  return `concurrency ${show(running)}, not ${show(wanted)}`;
}

export function setConcurrencyPrefs(
  concurrency: ConcurrencyPrefs,
  projectPath?: string,
): void {
  updateUserPrefs((prefs) => {
    const cleaned = { ...concurrency };
    if (cleaned.maxConcurrentTests === undefined) {
      delete cleaned.maxConcurrentTests;
    }
    if (cleaned.maxBootingTests === undefined) {
      delete cleaned.maxBootingTests;
    }

    if (projectPath) {
      const projects = { ...prefs.projects };
      const project = { ...projects[projectPath] };
      if (Object.keys(cleaned).length === 0) {
        delete project.concurrency;
      } else {
        const merged = { ...project.concurrency, ...cleaned };
        if (merged.maxConcurrentTests === undefined) {
          delete merged.maxConcurrentTests;
        }
        if (merged.maxBootingTests === undefined) {
          delete merged.maxBootingTests;
        }
        project.concurrency =
          Object.keys(merged).length > 0 ? merged : undefined;
        if (!project.concurrency) {
          delete project.concurrency;
        }
      }
      if (Object.keys(project).length === 0) {
        delete projects[projectPath];
      } else {
        projects[projectPath] = project;
      }
      if (Object.keys(projects).length === 0) {
        const { projects: _, ...rest } = prefs;
        return rest;
      }
      return { ...prefs, projects };
    }

    const merged = { ...prefs.concurrency, ...cleaned };
    if (merged.maxConcurrentTests === undefined) {
      delete merged.maxConcurrentTests;
    }
    if (merged.maxBootingTests === undefined) {
      delete merged.maxBootingTests;
    }
    if (Object.keys(merged).length === 0) {
      const { concurrency: _, ...rest } = prefs;
      return rest;
    }
    return { ...prefs, concurrency: merged };
  });
}

const DEFAULT_MAX_RUN_HISTORY = 2;

export function getMaxRunHistory(projectPath?: string): number {
  const prefs = getUserPrefs();
  let value = prefs.maxRunHistory ?? DEFAULT_MAX_RUN_HISTORY;
  if (projectPath) {
    const projectValue = prefs.projects?.[projectPath]?.maxRunHistory;
    if (projectValue !== undefined) {
      value = projectValue;
    }
  }
  return Math.max(1, value);
}

export function setMaxRunHistory(
  value: number | undefined,
  projectPath?: string,
): void {
  updateUserPrefs((prefs) => {
    if (projectPath) {
      const projects = { ...prefs.projects };
      const project = { ...projects[projectPath] };
      if (value === undefined) {
        delete project.maxRunHistory;
      } else {
        project.maxRunHistory = value;
      }
      if (Object.keys(project).length === 0) {
        delete projects[projectPath];
      } else {
        projects[projectPath] = project;
      }
      if (Object.keys(projects).length === 0) {
        const { projects: _, ...rest } = prefs;
        return rest;
      }
      return { ...prefs, projects };
    }
    if (value === undefined) {
      const { maxRunHistory: _, ...rest } = prefs;
      return rest;
    }
    return { ...prefs, maxRunHistory: value };
  });
}
