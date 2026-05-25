import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import {
  validateDefinition,
  resolveRefs,
  resolveVariablesRef,
  resolveActionRefs,
  isDefinitionFile,
  parseDefinitionFile,
  type ValidationResult,
  type FileSystem,
} from '@dokkimi/definition-validator';

const nodeFs: FileSystem = {
  existsSync: fs.existsSync,
  readFileSync: (p) => fs.readFileSync(p, 'utf-8'),
};

function trackingFs(consumed: Set<string>): FileSystem {
  return {
    existsSync: fs.existsSync,
    readFileSync: (p) => {
      consumed.add(path.resolve(p));
      return fs.readFileSync(p, 'utf-8');
    },
  };
}

// ---------------------------------------------------------------------------
// Global config (.dokkimi/config.yaml)
// ---------------------------------------------------------------------------

const CONFIG_FILENAMES = ['config.yaml', 'config.yml', 'config.json'];
const ENV_REF_RE = /\$\{\{(\w+)\}\}/g;

export interface DokkimiConfig {
  dokkimi?: string;
  env: Record<string, string>;
}

/**
 * Loads the project config file from the .dokkimi/ root directory.
 * Looks for config.yaml, config.yml, or config.json (first match wins).
 * Returns defaults if no config file exists.
 */
function loadDokkimiConfig(
  dokkimiDir: string,
  errors: ResolverError[],
): DokkimiConfig {
  const empty: DokkimiConfig = { env: {} };

  for (const filename of CONFIG_FILENAMES) {
    const configPath = path.join(dokkimiDir, filename);
    if (!nodeFs.existsSync(configPath)) {
      continue;
    }

    let parsed: unknown;
    try {
      const raw = nodeFs.readFileSync(configPath);
      parsed = parseDefinitionFile(configPath, raw);
    } catch (e) {
      errors.push({
        file: configPath,
        errors: [`Config parse error: ${e instanceof Error ? e.message : e}`],
        warnings: [],
      });
      return empty;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push({
        file: configPath,
        errors: ['Config file must be a plain object'],
        warnings: [],
      });
      return empty;
    }

    const obj = parsed as Record<string, unknown>;
    const config: DokkimiConfig = { env: {} };

    // Parse dokkimi version field
    if (obj.dokkimi !== undefined) {
      if (typeof obj.dokkimi !== 'string' && typeof obj.dokkimi !== 'number') {
        errors.push({
          file: configPath,
          errors: ['"dokkimi" field must be a version string (e.g. "0.1.0")'],
          warnings: [],
        });
        return empty;
      }
      config.dokkimi = String(obj.dokkimi);
    }

    // Parse env map
    if (obj.env !== undefined) {
      if (!obj.env || typeof obj.env !== 'object' || Array.isArray(obj.env)) {
        errors.push({
          file: configPath,
          errors: ['"env" must be a plain object with string values'],
          warnings: [],
        });
        return empty;
      }

      for (const [key, value] of Object.entries(
        obj.env as Record<string, unknown>,
      )) {
        if (!/^\w+$/.test(key)) {
          errors.push({
            file: configPath,
            errors: [
              `env key "${key}" must be alphanumeric (letters, digits, underscores)`,
            ],
            warnings: [],
          });
          return empty;
        }
        if (typeof value !== 'string' && typeof value !== 'number') {
          errors.push({
            file: configPath,
            errors: [`env key "${key}" must be a string, got ${typeof value}`],
            warnings: [],
          });
          return empty;
        }
        config.env[key] = String(value);
      }
    }

    return config;
  }

  return empty;
}

/**
 * Recursively walks a value and replaces ${{KEY}} placeholders in strings
 * with matching env values. Collects any unresolved references as errors.
 */
function interpolateEnv<T>(
  value: T,
  env: Record<string, string>,
  unresolved: Set<string>,
): T {
  if (typeof value === 'string') {
    return value.replace(ENV_REF_RE, (match, varName) => {
      if (varName in env) {
        return env[varName];
      }
      unresolved.add(varName);
      return match;
    }) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      interpolateEnv(item, env, unresolved),
    ) as unknown as T;
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = interpolateEnv(v, env, unresolved);
    }
    return result as T;
  }

  return value;
}

export interface ResolverError {
  file: string;
  errors: string[];
  warnings: string[];
}

export interface InitFileEntry {
  itemName: string;
  filename: string;
  content: Buffer;
}

export interface ResolvedDefinition {
  /** The definition name */
  name: string;
  /** Fully resolved definition JSON (items with $ref merged, ready to send to CT) */
  definition: Record<string, unknown>;
  /** Init files read from disk, ready to send to CT */
  initFiles: InitFileEntry[];
  /** Source file path */
  sourceFile: string;
}

export interface ResolverResult {
  definitions: ResolvedDefinition[];
  errors: ResolverError[];
  /** Parsed project config from .dokkimi/config.yaml */
  config: DokkimiConfig;
  /** All file paths consumed during resolution (definition files, $ref targets, init files, config) */
  consumedFiles: string[];
  /** Absolute path to the resolved .dokkimi/ directory (undefined on early error exits) */
  dokkimiDir?: string;
}

/**
 * Discovers, resolves, and validates definition files.
 * This is the shared library used by both CLI and Electron.
 *
 * @param target - Path to a .json file, a directory, a pattern (glob/regex/substring), or undefined (defaults to .dokkimi/)
 * @returns Resolved definitions ready for submission to CT, or errors
 */
export function resolveDefinitions(target?: string): ResolverResult {
  const emptyConfig: DokkimiConfig = { env: {} };
  let dokkimiDir: string;
  let filesToProcess: string[];

  if (target && isDefinitionFile(target)) {
    // Case 1: Specific definition file
    if (!fs.existsSync(target)) {
      return {
        definitions: [],
        errors: [{ file: target, errors: ['File not found'], warnings: [] }],
        config: emptyConfig,
        consumedFiles: [],
      };
    }
    const absTarget = path.resolve(target);
    dokkimiDir = findDokkimiDir(absTarget) || path.dirname(absTarget);
    filesToProcess = [absTarget];
  } else if (target && fs.existsSync(path.resolve(target))) {
    // Case 2: Existing directory
    const absTarget = path.resolve(target);
    const stat = fs.statSync(absTarget);
    if (!stat.isDirectory()) {
      return {
        definitions: [],
        errors: [
          {
            file: absTarget,
            errors: ['Not a definition file (.json, .yml, .yaml)'],
            warnings: [],
          },
        ],
        config: emptyConfig,
        consumedFiles: [],
      };
    }
    // 2a: Directory contains a .dokkimi subfolder → use it
    const dokkimiSubdir = path.join(absTarget, '.dokkimi');
    if (
      fs.existsSync(dokkimiSubdir) &&
      fs.statSync(dokkimiSubdir).isDirectory()
    ) {
      dokkimiDir = dokkimiSubdir;
      filesToProcess = scanDefinitionFiles(dokkimiDir);
    } else {
      // 2b: Directory is inside a .dokkimi tree → use .dokkimi root, scan this subtree
      const ancestorDokkimi = findDokkimiDirFrom(absTarget);
      if (ancestorDokkimi) {
        dokkimiDir = ancestorDokkimi;
        filesToProcess = scanDefinitionFiles(
          absTarget,
          loadDokignore(dokkimiDir),
          dokkimiDir,
        );
      } else {
        // 2c: Standalone directory (no .dokkimi context) → scan as-is
        dokkimiDir = absTarget;
        filesToProcess = scanDefinitionFiles(dokkimiDir);
      }
    }
  } else if (target) {
    // Case 3: Not a real path → treat as a filter pattern (glob, regex, or substring)
    dokkimiDir =
      findDokkimiDirFrom(path.resolve(process.cwd())) ||
      path.join(process.cwd(), '.dokkimi');
    if (!fs.existsSync(dokkimiDir)) {
      return {
        definitions: [],
        errors: [
          {
            file: dokkimiDir,
            errors: [
              `.dokkimi/ not found. Run from a directory with .dokkimi/ or provide a path.`,
            ],
            warnings: [],
          },
        ],
        config: emptyConfig,
        consumedFiles: [],
      };
    }
    const allFiles = scanDefinitionFiles(dokkimiDir);
    filesToProcess = filterFilesByPattern(allFiles, dokkimiDir, target);
  } else {
    // Case 4: No target — default to .dokkimi/ in cwd (or walk up)
    const cwd = path.resolve(process.cwd());
    dokkimiDir = findDokkimiDirFrom(cwd) || path.join(cwd, '.dokkimi');
    if (!fs.existsSync(dokkimiDir)) {
      return {
        definitions: [],
        errors: [
          {
            file: dokkimiDir,
            errors: [`.dokkimi/ not found at ${dokkimiDir}`],
            warnings: [],
          },
        ],
        config: emptyConfig,
        consumedFiles: [],
      };
    }
    // If cwd is a subdirectory inside the .dokkimi/ tree (not the root itself),
    // scan only from cwd so users can scope runs by directory.
    if (cwd !== dokkimiDir && cwd.startsWith(dokkimiDir + path.sep)) {
      filesToProcess = scanDefinitionFiles(
        cwd,
        loadDokignore(dokkimiDir),
        dokkimiDir,
      );
    } else {
      filesToProcess = scanDefinitionFiles(dokkimiDir);
    }
  }

  // Load project config (.dokkimi/config.yaml)
  const errors: ResolverError[] = [];
  const config = loadDokkimiConfig(dokkimiDir, errors);

  if (filesToProcess.length === 0) {
    return { definitions: [], errors, config, consumedFiles: [], dokkimiDir };
  }

  const resolved: ResolvedDefinition[] = [];
  const seenNames = new Set<string>();
  const consumedFiles = new Set<string>();
  const tFs = trackingFs(consumedFiles);

  for (const filename of CONFIG_FILENAMES) {
    const configPath = path.resolve(dokkimiDir, filename);
    if (fs.existsSync(configPath)) {
      consumedFiles.add(configPath);
      break;
    }
  }

  for (const filePath of filesToProcess) {
    consumedFiles.add(path.resolve(filePath));
    let parsed: unknown;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      parsed = parseDefinitionFile(filePath, raw);
    } catch (e) {
      errors.push({
        file: filePath,
        errors: [`Parse error: ${e instanceof Error ? e.message : e}`],
        warnings: [],
      });
      continue;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      continue; // Skip non-objects
    }

    const obj = parsed as Record<string, unknown>;

    const hasName = typeof obj.name === 'string';
    const hasItems = Array.isArray(obj.items);
    if (!hasName || !hasItems) {
      continue;
    }

    const name = obj.name as string;
    const items = obj.items as unknown[];

    // Validate
    const r: ValidationResult = {
      file: path.relative(dokkimiDir, filePath),
      kind: 'definition',
      errors: [],
      warnings: [],
    };

    resolveActionRefs(obj, filePath, r, tFs);
    validateDefinition(obj, filePath, r, tFs);

    if (r.errors.length > 0) {
      errors.push({ file: filePath, errors: r.errors, warnings: r.warnings });
      continue;
    }

    // Check for duplicate names
    if (seenNames.has(name)) {
      errors.push({
        file: filePath,
        errors: [`Duplicate definition name "${name}"`],
        warnings: [],
      });
      continue;
    }
    seenNames.add(name);

    // Resolve $ref references
    const resolvedItems = resolveRefs(items, filePath, r, tFs);

    if (r.errors.length > 0) {
      errors.push({ file: filePath, errors: r.errors, warnings: r.warnings });
      continue;
    }

    // Resolve $ref in definition-level variables
    if (
      obj.variables &&
      typeof obj.variables === 'object' &&
      !Array.isArray(obj.variables)
    ) {
      const vars = obj.variables as Record<string, unknown>;
      if (vars.$ref !== undefined) {
        const resolved = resolveVariablesRef(vars, filePath, r, tFs);
        if (resolved) {
          obj.variables = resolved;
        }
      }
    }

    // Resolve $ref in test-level variables
    if (Array.isArray(obj.tests)) {
      for (const test of obj.tests as Record<string, unknown>[]) {
        if (
          test.variables &&
          typeof test.variables === 'object' &&
          !Array.isArray(test.variables)
        ) {
          const vars = test.variables as Record<string, unknown>;
          if (vars.$ref !== undefined) {
            const resolved = resolveVariablesRef(vars, filePath, r, tFs);
            if (resolved) {
              test.variables = resolved;
            }
          }
        }
      }
    }

    if (r.errors.length > 0) {
      errors.push({ file: filePath, errors: r.errors, warnings: r.warnings });
      continue;
    }

    // Build the fully resolved definition
    const resolvedDef: Record<string, unknown> = {
      ...obj,
      items: resolvedItems.map((ri) => ri.item),
    };

    // Read init files from disk
    const initFiles: InitFileEntry[] = [];
    let initFileError = false;
    for (const ri of resolvedItems) {
      const item = ri.item;
      if (item.type !== 'DATABASE') {
        continue;
      }

      const initPaths = collectInitFilePaths(item);
      const allowedRoot = dokkimiDir;
      for (const initPath of initPaths) {
        const absInitPath = path.resolve(path.dirname(ri.sourceFile), initPath);
        // Prevent path traversal outside the .dokkimi directory
        if (
          !absInitPath.startsWith(allowedRoot + path.sep) &&
          absInitPath !== allowedRoot
        ) {
          errors.push({
            file: filePath,
            errors: [
              `Init file path "${initPath}" resolves outside the project directory`,
            ],
            warnings: [],
          });
          initFileError = true;
          continue;
        }
        if (!fs.existsSync(absInitPath)) {
          errors.push({
            file: filePath,
            errors: [
              `Init file not found: "${initPath}" (resolved to ${absInitPath})`,
            ],
            warnings: [],
          });
          initFileError = true;
          continue;
        }
        consumedFiles.add(absInitPath);
        initFiles.push({
          itemName: item.name as string,
          filename: path.basename(absInitPath),
          content: fs.readFileSync(absInitPath),
        });
      }
    }

    if (initFileError) {
      continue;
    }

    // Interpolate ${{KEY}} references from config env
    const unresolved = new Set<string>();
    const finalDef = interpolateEnv(resolvedDef, config.env, unresolved);
    if (unresolved.size > 0) {
      const keys = [...unresolved].map((k) => '${{' + k + '}}').join(', ');
      errors.push({
        file: filePath,
        errors: [
          `Unresolved config references: ${keys}. Add these keys to env in .dokkimi/config.yaml`,
        ],
        warnings: [],
      });
      continue;
    }

    resolved.push({
      name,
      definition: finalDef,
      initFiles,
      sourceFile: filePath,
    });

    // Report warnings
    if (r.warnings.length > 0) {
      errors.push({ file: filePath, errors: [], warnings: r.warnings });
    }
  }

  return {
    definitions: resolved,
    errors,
    config,
    consumedFiles: [...consumedFiles],
    dokkimiDir,
  };
}

// ============================================
// Helpers
// ============================================

interface IgnoreRules {
  exact: Set<string>;
  globs: string[];
}

function scanDefinitionFiles(
  scanDir: string,
  ignoreRules?: IgnoreRules,
  ignoreRoot?: string,
): string[] {
  if (!ignoreRules) {
    ignoreRules = loadDokignore(scanDir);
  }
  // ignoreRoot is the directory that .dokignore paths are relative to (the .dokkimi root).
  // Falls back to scanDir when scanning from the .dokkimi root directly.
  const relRoot = ignoreRoot ?? scanDir;

  const files: string[] = [];

  function isIgnored(rel: string, fileName: string): boolean {
    if (ignoreRules!.exact.has(rel) || ignoreRules!.exact.has(fileName)) {
      return true;
    }
    return ignoreRules!.globs.some(
      (pattern) => minimatch(rel, pattern) || minimatch(fileName, pattern),
    );
  }

  function walk(dir: string) {
    if (!fs.existsSync(dir)) {
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (isDefinitionFile(entry.name)) {
        const rel = path.relative(relRoot, full);
        if (isIgnored(rel, entry.name)) {
          continue;
        }
        files.push(full);
      }
    }
  }

  walk(scanDir);
  return files;
}

function loadDokignore(dokkimiDir: string): IgnoreRules {
  const ignorePath = path.join(dokkimiDir, '.dokignore');
  if (!fs.existsSync(ignorePath)) {
    return { exact: new Set(), globs: [] };
  }

  const content = fs.readFileSync(ignorePath, 'utf-8');
  const exact = new Set<string>();
  const globs: string[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    if (
      trimmed.includes('*') ||
      trimmed.includes('?') ||
      trimmed.includes('{')
    ) {
      globs.push(trimmed);
    } else {
      exact.add(trimmed);
    }
  }
  return { exact, globs };
}

function findDokkimiDir(filePath: string): string | null {
  let dir = path.dirname(filePath);
  while (true) {
    if (path.basename(dir) === '.dokkimi') {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * Walk up from a directory looking for a `.dokkimi` ancestor OR a `.dokkimi` child.
 * Checks: dir itself (if named .dokkimi), then dir/.dokkimi, then walks up.
 */
function findDokkimiDirFrom(dir: string): string | null {
  // Check if dir itself is .dokkimi
  if (path.basename(dir) === '.dokkimi') {
    return dir;
  }
  // Check if dir is inside a .dokkimi tree
  const ancestor = findDokkimiDir(path.join(dir, '_placeholder'));
  if (ancestor) {
    return ancestor;
  }
  // Check if dir contains a .dokkimi child
  const child = path.join(dir, '.dokkimi');
  if (fs.existsSync(child) && fs.statSync(child).isDirectory()) {
    return child;
  }
  // Walk up looking for directories that contain .dokkimi
  let current = path.dirname(dir);
  while (true) {
    const candidate = path.join(current, '.dokkimi');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * Filters files by a pattern string. Supports:
 * - Glob patterns (if contains *, ?, {, }, [, ])
 * - Regex patterns (if starts/ends with /)
 * - Substring match (default)
 * Matches against both the relative path from .dokkimi and the file basename (without extension).
 */
function filterFilesByPattern(
  files: string[],
  dokkimiDir: string,
  pattern: string,
): string[] {
  const isGlob = /[*?{}[\]]/.test(pattern);
  const isRegex = pattern.startsWith('/') && pattern.lastIndexOf('/') > 0;

  let regex: RegExp | null = null;
  if (isRegex) {
    const lastSlash = pattern.lastIndexOf('/');
    const body = pattern.slice(1, lastSlash);
    const flags = pattern.slice(lastSlash + 1) || 'i';
    try {
      regex = new RegExp(body, flags);
    } catch {
      // Invalid regex — fall through to substring matching
    }
  } else if (!isGlob) {
    // Try to compile as regex (for patterns like "auth.*" without explicit //)
    try {
      regex = new RegExp(pattern, 'i');
    } catch {
      // Not valid regex — will use substring match
    }
  }

  return files.filter((f) => {
    const rel = path.relative(dokkimiDir, f);
    const basename = path.basename(f, path.extname(f));
    const basenameWithExt = path.basename(f);

    if (isGlob) {
      return (
        minimatch(rel, pattern, { matchBase: true }) ||
        minimatch(rel, `**/${pattern}`, { matchBase: true }) ||
        minimatch(basenameWithExt, pattern)
      );
    }

    if (regex) {
      return regex.test(rel) || regex.test(basename);
    }

    // Substring match (case-insensitive)
    const lower = pattern.toLowerCase();
    return (
      rel.toLowerCase().includes(lower) ||
      basename.toLowerCase().includes(lower)
    );
  });
}

function collectInitFilePaths(item: Record<string, unknown>): string[] {
  const paths: string[] = [];
  if (typeof item.initFilePath === 'string') {
    paths.push(item.initFilePath);
  }
  if (Array.isArray(item.initFilePaths)) {
    for (const p of item.initFilePaths) {
      if (typeof p === 'string') {
        paths.push(p);
      }
    }
  }
  return paths;
}
