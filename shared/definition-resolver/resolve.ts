import * as fs from 'fs';
import * as path from 'path';
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

import {
  CONFIG_FILENAMES,
  loadDokkimiConfig,
  type DokkimiConfig,
} from './config-loader';
import {
  interpolateEnv,
  interpolateVars,
  findLeftoverVarRefs,
} from './env-substitution';
import {
  scanDefinitionFiles,
  loadDokignore,
  findDokkimiDir,
  findDokkimiDirFrom,
  filterFilesByPattern,
  collectInitFilePaths,
} from './glob-resolver';

export type { DokkimiConfig } from './config-loader';

function trackingFs(consumed: Set<string>): FileSystem {
  return {
    existsSync: fs.existsSync,
    readFileSync: (p) => {
      consumed.add(path.resolve(p));
      return fs.readFileSync(p, 'utf-8');
    },
  };
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

export interface MountFileEntry {
  itemName: string;
  source: string;
  target: string;
  content: Buffer;
}

export interface ResolvedDefinition {
  /** The definition name */
  name: string;
  /** Fully resolved definition JSON (items with $ref merged, ready to send to CT) */
  definition: Record<string, unknown>;
  /** Init files read from disk, ready to send to CT */
  initFiles: InitFileEntry[];
  /** Mount files read from disk, ready to send to CT */
  mountFiles: MountFileEntry[];
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

    // Read mount files from disk (SERVICE items)
    const mountFiles: MountFileEntry[] = [];
    let mountFileError = false;
    for (const ri of resolvedItems) {
      const item = ri.item;
      if (
        (item.type !== 'SERVICE' && item.type !== 'WORKER') ||
        !Array.isArray(item.mountFiles)
      ) {
        continue;
      }
      const allowedRoot = path.dirname(dokkimiDir);
      for (const mf of item.mountFiles as Array<{
        source: string;
        target: string;
      }>) {
        const absMountPath = path.resolve(
          path.dirname(ri.sourceFile),
          mf.source,
        );
        if (
          !absMountPath.startsWith(allowedRoot + path.sep) &&
          absMountPath !== allowedRoot
        ) {
          errors.push({
            file: filePath,
            errors: [
              `Mount file path "${mf.source}" resolves outside the project directory`,
            ],
            warnings: [],
          });
          mountFileError = true;
          continue;
        }
        if (!fs.existsSync(absMountPath)) {
          errors.push({
            file: filePath,
            errors: [
              `Mount file not found: "${mf.source}" (resolved to ${absMountPath})`,
            ],
            warnings: [],
          });
          mountFileError = true;
          continue;
        }
        consumedFiles.add(absMountPath);
        mountFiles.push({
          itemName: item.name as string,
          source: path.basename(absMountPath),
          target: mf.target,
          content: fs.readFileSync(absMountPath),
        });
      }
    }

    if (mountFileError) {
      continue;
    }

    // Interpolate {{VAR}} in items from merged variables (config.yaml baseline + definition overrides)
    const buildVars: Record<string, string> = { ...config.env };
    if (
      obj.variables &&
      typeof obj.variables === 'object' &&
      !Array.isArray(obj.variables)
    ) {
      for (const [k, v] of Object.entries(
        obj.variables as Record<string, unknown>,
      )) {
        if (typeof v === 'string') {
          buildVars[k] = v;
        }
      }
    }

    const unresolvedVars = new Set<string>();
    resolvedDef.items = interpolateVars(
      resolvedDef.items as unknown[],
      buildVars,
      unresolvedVars,
    );
    if (unresolvedVars.size > 0) {
      const keys = [...unresolvedVars].map((k) => '{{' + k + '}}').join(', ');
      errors.push({
        file: filePath,
        errors: [
          `Unresolved variables in items: ${keys}. Define these in the definition's variables or config.yaml env.`,
        ],
        warnings: [],
      });
      continue;
    }

    const leftoverRefs = findLeftoverVarRefs(resolvedDef.items);
    if (leftoverRefs.length > 0) {
      const unique = [...new Set(leftoverRefs)].join(', ');
      errors.push({
        file: filePath,
        errors: [
          `Invalid variable references in items: ${unique}. Only simple {{key}} references are supported in item fields.`,
        ],
        warnings: [],
      });
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
      mountFiles,
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
