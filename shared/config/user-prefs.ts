import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const PREFS_FILE = path.join(os.homedir(), '.dokkimi', 'config.json');

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

export function getConcurrencyPrefs(): ConcurrencyPrefs {
  return getUserPrefs().concurrency ?? {};
}

export function setConcurrencyPrefs(concurrency: ConcurrencyPrefs): void {
  updateUserPrefs((prefs) => {
    const cleaned = { ...concurrency };
    if (cleaned.maxConcurrentTests === undefined) {
      delete cleaned.maxConcurrentTests;
    }
    if (cleaned.maxBootingTests === undefined) {
      delete cleaned.maxBootingTests;
    }
    if (Object.keys(cleaned).length === 0) {
      const { concurrency: _, ...rest } = prefs;
      return rest;
    }
    return { ...prefs, concurrency: cleaned };
  });
}

const DEFAULT_MAX_RUN_HISTORY = 2;

export function getMaxRunHistory(projectPath?: string): number {
  const prefs = getUserPrefs();
  if (projectPath) {
    const projectValue = prefs.projects?.[projectPath]?.maxRunHistory;
    if (projectValue !== undefined) {
      return projectValue;
    }
  }
  return prefs.maxRunHistory ?? DEFAULT_MAX_RUN_HISTORY;
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
