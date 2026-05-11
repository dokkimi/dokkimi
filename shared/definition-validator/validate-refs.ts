import * as path from 'path';
import { parseDefinitionFile } from './parse';
import {
  ValidationResult,
  FileSystem,
  err,
  warn,
  MAX_REF_DEPTH,
} from './validate-helpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface ResolvedItem {
  item: Record<string, unknown>;
  /** The file this item was declared in (the $ref target, or the definition file for inline items). */
  sourceFile: string;
}

function getByDotPath(obj: Record<string, unknown>, dotPath: string): unknown {
  return dotPath
    .split('.')
    .reduce<unknown>(
      (cur, seg) =>
        cur && typeof cur === 'object'
          ? (cur as Record<string, unknown>)[seg]
          : undefined,
      obj,
    );
}

function expandRefSpreads(
  arr: unknown[],
  refContent: Record<string, unknown>,
): unknown[] {
  return arr.flatMap((el) => {
    if (typeof el === 'string' && el.startsWith('...$ref.')) {
      const refPath = el.slice('...$ref.'.length);
      if (!refPath) {
        return [];
      }
      const base = getByDotPath(refContent, refPath);
      return Array.isArray(base) ? base : [];
    }
    return [el];
  });
}

// ---------------------------------------------------------------------------
// $ref resolution
// ---------------------------------------------------------------------------

export function resolveRefs(
  items: unknown[],
  defFilePath: string,
  r: ValidationResult,
  fs: FileSystem,
  _visited?: Set<string>,
): ResolvedItem[] {
  const visited = _visited ?? new Set([path.resolve(defFilePath)]);
  const resolved: ResolvedItem[] = [];

  if (visited.size > MAX_REF_DEPTH) {
    err(r, `$ref chain exceeds maximum depth of ${MAX_REF_DEPTH}`);
    return resolved;
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>;
    if (!item || typeof item !== 'object') {
      err(r, `items[${i}]: must be an object`);
      continue;
    }

    if (typeof item.$ref === 'string' || Array.isArray(item.$ref)) {
      // Normalize $ref to array
      const refs: string[] =
        typeof item.$ref === 'string' ? [item.$ref] : (item.$ref as string[]);

      // Resolve and merge left-to-right
      let refContent: Record<string, unknown> = {};
      let lastRefPath: string | null = null;
      let hasError = false;
      for (const ref of refs) {
        if (typeof ref !== 'string') {
          err(r, `items[${i}]: $ref array entries must be strings`);
          hasError = true;
          continue;
        }
        const refPath = path.resolve(path.dirname(defFilePath), ref);
        if (visited.has(refPath)) {
          err(
            r,
            `items[${i}]: circular $ref detected — "${ref}" already in resolution chain`,
          );
          hasError = true;
          continue;
        }
        if (!fs.existsSync(refPath)) {
          err(
            r,
            `items[${i}]: $ref "${ref}" not found (resolved to ${refPath})`,
          );
          hasError = true;
          continue;
        }
        try {
          const parsed = parseDefinitionFile(
            refPath,
            fs.readFileSync(refPath),
          ) as Record<string, unknown>;

          if (parsed.$ref !== undefined) {
            const innerVisited = new Set(visited);
            innerVisited.add(refPath);
            const innerResolved = resolveRefs(
              [parsed],
              refPath,
              r,
              fs,
              innerVisited,
            );
            if (innerResolved.length === 0) {
              hasError = true;
              continue;
            }
            refContent = { ...refContent, ...innerResolved[0].item };
            lastRefPath = innerResolved[0].sourceFile;
          } else {
            refContent = { ...refContent, ...parsed };
            lastRefPath = refPath;
          }
        } catch {
          err(r, `items[${i}]: $ref "${ref}" could not be parsed`);
          hasError = true;
        }
      }

      if (hasError) {
        continue;
      }

      const { $ref: _, ...overrides } = item;
      const merged = { ...refContent, ...overrides } as Record<string, unknown>;

      // Array spread markers expand against merged ref content
      for (const key of Object.keys(overrides)) {
        const val = (overrides as Record<string, unknown>)[key];
        if (Array.isArray(val)) {
          merged[key] = expandRefSpreads(val, refContent);
        }
      }

      resolved.push({ item: merged, sourceFile: lastRefPath || defFilePath });
    } else {
      resolved.push({ item, sourceFile: defFilePath });
    }
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Action and UI sub-step $ref resolution
// ---------------------------------------------------------------------------

const FRAGMENT_META_KEYS = new Set(['name', 'description']);

/**
 * Walks a definition's tests and resolves two kinds of action-level `$ref`:
 *
 * 1. **Action ref** (all action types) — `$ref` on `step.action` loads a
 *    fragment with `{ action: {...} }` and shallow-merges inline overrides.
 *
 * 2. **UI sub-step ref** — `$ref` entries inside a UI action's `steps` array
 *    load fragments with `{ steps: [...] }` and splice them in place.
 *
 * Both fragment types accept optional `name` and `description` metadata.
 *
 * Must be called BEFORE validateDefinition() so the validator and
 * screenshot-uniqueness checker see the fully expanded results.
 */
export function resolveActionRefs(
  definition: Record<string, unknown>,
  defFilePath: string,
  r: ValidationResult,
  fs: FileSystem,
  _visited?: Set<string>,
): void {
  const visited = _visited ?? new Set([path.resolve(defFilePath)]);
  const tests = definition.tests;
  if (!Array.isArray(tests)) {
    return;
  }

  for (let ti = 0; ti < tests.length; ti++) {
    const test = tests[ti] as Record<string, unknown>;
    if (!test || typeof test !== 'object' || !Array.isArray(test.steps)) {
      continue;
    }

    for (let si = 0; si < (test.steps as unknown[]).length; si++) {
      const step = (test.steps as unknown[])[si] as Record<string, unknown>;
      if (!step || typeof step !== 'object') {
        continue;
      }
      const action = step.action as Record<string, unknown> | undefined;
      if (!action || typeof action !== 'object') {
        continue;
      }

      const ctx = `tests[${ti}].steps[${si}].action`;

      // 1. Action-level $ref: load the fragment's `action` and merge
      if (typeof action.$ref === 'string') {
        const resolved = resolveActionRef(
          action,
          ctx,
          defFilePath,
          r,
          fs,
          visited,
        );
        if (resolved) {
          step.action = resolved;
        }
        continue;
      }

      // 2. UI sub-step refs: splice $ref entries inside action.steps
      if (action.type === 'ui' && Array.isArray(action.steps)) {
        action.steps = expandSubStepRefs(
          action.steps as unknown[],
          ctx,
          defFilePath,
          r,
          fs,
          visited,
        );
      }
    }
  }
}

function resolveActionRef(
  action: Record<string, unknown>,
  ctx: string,
  defFilePath: string,
  r: ValidationResult,
  fs: FileSystem,
  _visited?: Set<string>,
): Record<string, unknown> | null {
  const visited = _visited ?? new Set([path.resolve(defFilePath)]);

  if (visited.size > MAX_REF_DEPTH) {
    err(r, `${ctx}.$ref: $ref chain exceeds maximum depth of ${MAX_REF_DEPTH}`);
    return null;
  }

  const refValue = action.$ref as string;
  const refPath = path.resolve(path.dirname(defFilePath), refValue);

  if (visited.has(refPath)) {
    err(
      r,
      `${ctx}.$ref: circular $ref detected — "${refValue}" already in resolution chain`,
    );
    return null;
  }

  if (!fs.existsSync(refPath)) {
    err(r, `${ctx}.$ref: "${refValue}" not found (resolved to ${refPath})`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parseDefinitionFile(refPath, fs.readFileSync(refPath));
  } catch {
    err(r, `${ctx}.$ref: "${refValue}" could not be parsed`);
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    err(
      r,
      `${ctx}.$ref: "${refValue}" must be a plain object with an "action" field`,
    );
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  if (
    !obj.action ||
    typeof obj.action !== 'object' ||
    Array.isArray(obj.action)
  ) {
    err(r, `${ctx}.$ref: "${refValue}" must contain an "action" object`);
    return null;
  }

  const unknownKeys = Object.keys(obj).filter(
    (k) => k !== 'action' && !FRAGMENT_META_KEYS.has(k),
  );
  if (unknownKeys.length > 0) {
    warn(
      r,
      `${ctx}.$ref: "${refValue}" has extra keys (${unknownKeys.join(', ')}) — only "action", "name", "description" are recognized`,
    );
  }

  let resolvedAction = obj.action as Record<string, unknown>;

  // Recursively resolve if the fragment's action itself has $ref
  if (typeof resolvedAction.$ref === 'string') {
    const innerVisited = new Set(visited);
    innerVisited.add(refPath);
    const inner = resolveActionRef(
      resolvedAction,
      ctx,
      refPath,
      r,
      fs,
      innerVisited,
    );
    if (!inner) {
      return null;
    }
    resolvedAction = inner;
  }

  const { $ref: _, ...overrides } = action;
  return { ...resolvedAction, ...overrides };
}

function expandSubStepRefs(
  rawSteps: unknown[],
  ctx: string,
  defFilePath: string,
  r: ValidationResult,
  fs: FileSystem,
  _visited?: Set<string>,
): unknown[] {
  const visited = _visited ?? new Set([path.resolve(defFilePath)]);
  const expanded: unknown[] = [];

  if (visited.size > MAX_REF_DEPTH) {
    err(
      r,
      `${ctx}.steps: $ref chain exceeds maximum depth of ${MAX_REF_DEPTH}`,
    );
    return expanded;
  }

  for (let i = 0; i < rawSteps.length; i++) {
    const sub = rawSteps[i];
    if (
      !sub ||
      typeof sub !== 'object' ||
      Array.isArray(sub) ||
      !('$ref' in (sub as Record<string, unknown>))
    ) {
      expanded.push(sub);
      continue;
    }

    const refValue = (sub as Record<string, unknown>).$ref;
    if (typeof refValue !== 'string') {
      err(r, `${ctx}.steps[${i}].$ref: must be a string path`);
      continue;
    }

    const refPath = path.resolve(path.dirname(defFilePath), refValue);
    if (visited.has(refPath)) {
      err(
        r,
        `${ctx}.steps[${i}].$ref: circular $ref detected — "${refValue}" already in resolution chain`,
      );
      continue;
    }

    if (!fs.existsSync(refPath)) {
      err(
        r,
        `${ctx}.steps[${i}].$ref: "${refValue}" not found (resolved to ${refPath})`,
      );
      continue;
    }

    let parsed: unknown;
    try {
      parsed = parseDefinitionFile(refPath, fs.readFileSync(refPath));
    } catch {
      err(r, `${ctx}.steps[${i}].$ref: "${refValue}" could not be parsed`);
      continue;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      err(
        r,
        `${ctx}.steps[${i}].$ref: "${refValue}" must be a plain object with a "steps" array`,
      );
      continue;
    }

    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.steps)) {
      err(
        r,
        `${ctx}.steps[${i}].$ref: "${refValue}" must contain a "steps" array`,
      );
      continue;
    }

    const unknownKeys = Object.keys(obj).filter(
      (k) => k !== 'steps' && !FRAGMENT_META_KEYS.has(k),
    );
    if (unknownKeys.length > 0) {
      warn(
        r,
        `${ctx}.steps[${i}].$ref: "${refValue}" has extra keys (${unknownKeys.join(', ')}) — only "steps", "name", "description" are recognized`,
      );
    }

    const innerVisited = new Set(visited);
    innerVisited.add(refPath);
    const resolvedSteps = expandSubStepRefs(
      obj.steps as unknown[],
      ctx,
      refPath,
      r,
      fs,
      innerVisited,
    );
    expanded.push(...resolvedSteps);
  }

  return expanded;
}
