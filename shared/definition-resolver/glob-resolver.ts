import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { isDefinitionFile } from '@dokkimi/definition-validator';

export interface IgnoreRules {
  exact: Set<string>;
  globs: string[];
}

export function scanDefinitionFiles(
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

export function loadDokignore(dokkimiDir: string): IgnoreRules {
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

export function findDokkimiDir(filePath: string): string | null {
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
export function findDokkimiDirFrom(dir: string): string | null {
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
export function filterFilesByPattern(
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

export function collectInitFilePaths(item: Record<string, unknown>): string[] {
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
