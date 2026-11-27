import * as path from 'path';
import {
  VALID_HTTP_METHODS,
  VALID_TEST_KEYS,
  VALID_STEP_KEYS,
  VALID_ACTION_KEYS,
} from './constants';
import { parseDefinitionFile } from './parse';
import {
  ValidationResult,
  FileSystem,
  err,
  warn,
  checkUnknownKeys,
  checkFieldTypes,
  MAX_REF_DEPTH,
} from './validate-helpers';
import {
  validateAssertionBlock,
  validateExtractRules,
} from './validate-assertions';
import { validateUiAction } from './validate-ui-action';
import {
  validateLoopModifiers,
  validateLoopSiblingConflicts,
} from './validate-loops';

// ---------------------------------------------------------------------------
// Variable $ref resolution
// ---------------------------------------------------------------------------

export function resolveVariablesRef(
  variables: Record<string, unknown>,
  sourceFilePath: string,
  r: ValidationResult,
  fs: FileSystem,
  _visited?: Set<string>,
): Record<string, unknown> | null {
  const visited = _visited ?? new Set([path.resolve(sourceFilePath)]);

  if (visited.size > MAX_REF_DEPTH) {
    err(
      r,
      `variables.$ref: $ref chain exceeds maximum depth of ${MAX_REF_DEPTH}`,
    );
    return null;
  }

  const { $ref: refValue, ...inlineKeys } = variables;

  // If no $ref, just pass through (will be validated by caller)
  if (refValue === undefined) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(inlineKeys)) {
      result[key] = value;
    }
    return result;
  }

  // Normalize $ref to array
  let refs: string[];
  if (typeof refValue === 'string') {
    refs = [refValue];
  } else if (Array.isArray(refValue)) {
    refs = refValue as string[];
  } else {
    err(r, 'variables.$ref must be a string or array of strings');
    return null;
  }

  // Resolve and merge left-to-right
  const merged: Record<string, unknown> = {};
  let hasError = false;

  for (const ref of refs) {
    if (typeof ref !== 'string') {
      err(r, 'variables.$ref array entries must be strings');
      hasError = true;
      continue;
    }
    const refPath = path.resolve(path.dirname(sourceFilePath), ref);
    if (visited.has(refPath)) {
      err(
        r,
        `variables.$ref: circular $ref detected — "${ref}" already in resolution chain`,
      );
      hasError = true;
      continue;
    }
    if (!fs.existsSync(refPath)) {
      err(r, `variables.$ref "${ref}" not found (resolved to ${refPath})`);
      hasError = true;
      continue;
    }
    try {
      const parsed = parseDefinitionFile(refPath, fs.readFileSync(refPath));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        err(r, `variables.$ref "${ref}" must be a plain object`);
        hasError = true;
        continue;
      }
      const obj = parsed as Record<string, unknown>;

      // Recursively resolve if this file also has $ref
      if (obj.$ref !== undefined) {
        const innerVisited = new Set(visited);
        innerVisited.add(refPath);
        const innerResolved = resolveVariablesRef(
          obj,
          refPath,
          r,
          fs,
          innerVisited,
        );
        if (!innerResolved) {
          hasError = true;
          continue;
        }
        Object.assign(merged, innerResolved);
        continue;
      }

      for (const [key, value] of Object.entries(obj)) {
        if (!/^\w+$/.test(key)) {
          err(
            r,
            `variables.$ref "${ref}": key "${key}" must be alphanumeric (letters, digits, underscores)`,
          );
          hasError = true;
          continue;
        }
        merged[key] = value;
      }
    } catch {
      err(r, `variables.$ref "${ref}" could not be parsed`);
      hasError = true;
    }
  }

  if (hasError) {
    return null;
  }

  // Inline keys override refs
  for (const [key, value] of Object.entries(inlineKeys)) {
    merged[key] = value;
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Variables field validation
// ---------------------------------------------------------------------------

export function validateVariablesField(
  variables: unknown,
  ctx: string,
  sourceFilePath: string,
  r: ValidationResult,
  fs: FileSystem,
): void {
  if (variables === undefined) {
    return;
  }

  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
    err(r, `${ctx}: "variables" must be a plain object`);
    return;
  }

  const vars = variables as Record<string, unknown>;
  const resolved = resolveVariablesRef(vars, sourceFilePath, r, fs);
  if (!resolved) {
    return;
  }

  for (const [key, value] of Object.entries(resolved)) {
    if (!/^\w+$/.test(key)) {
      err(
        r,
        `${ctx}.variables: key "${key}" must be alphanumeric (letters, digits, underscores)`,
      );
    }
    if (value === undefined) {
      err(r, `${ctx}.variables: value for "${key}" must not be undefined`);
    }
  }
}

// ---------------------------------------------------------------------------
// Step validation
// ---------------------------------------------------------------------------

export function validateStep(
  step: Record<string, unknown>,
  ctx: string,
  r: ValidationResult,
): void {
  if (!step || typeof step !== 'object') {
    err(r, `${ctx}: must be an object`);
    return;
  }

  checkUnknownKeys(step, VALID_STEP_KEYS, ctx, r);
  checkFieldTypes(
    step,
    {
      name: 'string',
      description: 'string',
      stopOnFailure: 'boolean',
      extract: 'object',
    },
    ctx,
    r,
  );

  // When a step-level loop is present, action lives inside the loop body
  const hasLoopModifier =
    step.forEach !== undefined ||
    step.for !== undefined ||
    step.repeat !== undefined;

  if (!step.action || typeof step.action !== 'object') {
    if (!hasLoopModifier) {
      err(r, `${ctx}: missing "action" object`);
    }
    // Validate loop modifiers and siblings even without step-level action
    validateLoopModifiers(step, ctx, r);
    validateLoopSiblingConflicts(step, ctx, r);
    return;
  }

  const action = step.action as Record<string, unknown>;
  if (action.type === 'httpRequest') {
    checkUnknownKeys(action, VALID_ACTION_KEYS.httpRequest, `${ctx}.action`, r);
    if (
      !action.method ||
      !VALID_HTTP_METHODS.includes(
        action.method as (typeof VALID_HTTP_METHODS)[number],
      )
    ) {
      err(r, `${ctx}.action: httpRequest requires valid "method"`);
    }
    if (typeof action.url !== 'string') {
      err(r, `${ctx}.action: httpRequest requires "url"`);
    } else if (/^[^/]+:\d+/.test(action.url)) {
      warn(
        r,
        `${ctx}.action: url "${action.url}" contains a port — ports are not needed and are likely to cause test failures`,
      );
    }
    if (action.body !== undefined && action.formData !== undefined) {
      err(
        r,
        `${ctx}.action: httpRequest cannot have both "body" and "formData" — use one or the other`,
      );
    }
    if (
      action.formData !== undefined &&
      (!action.formData ||
        typeof action.formData !== 'object' ||
        Array.isArray(action.formData))
    ) {
      err(r, `${ctx}.action: "formData" must be an object`);
    }
    if (
      action.queryParams !== undefined &&
      (!action.queryParams ||
        typeof action.queryParams !== 'object' ||
        Array.isArray(action.queryParams))
    ) {
      err(r, `${ctx}.action: "queryParams" must be an object`);
    }
    if (
      action.timeout !== undefined &&
      (typeof action.timeout !== 'number' ||
        !Number.isInteger(action.timeout) ||
        action.timeout <= 0)
    ) {
      err(r, `${ctx}.action: "timeout" must be a positive integer (ms)`);
    }
    checkFieldTypes(action, { headers: 'object' }, `${ctx}.action`, r);
    if (
      action.headers &&
      typeof action.headers === 'object' &&
      !Array.isArray(action.headers)
    ) {
      for (const [h, v] of Object.entries(action.headers)) {
        if (typeof v !== 'string') {
          err(
            r,
            `${ctx}.action.headers: "${h}" must be a string — quote it: "${String(v)}"`,
          );
        }
      }
    }
  } else if (action.type === 'dbQuery') {
    checkUnknownKeys(action, VALID_ACTION_KEYS.dbQuery, `${ctx}.action`, r);
    if (typeof action.database !== 'string') {
      err(
        r,
        `${ctx}.action: dbQuery requires "database" (database service name)`,
      );
    }
    if (typeof action.query !== 'string') {
      err(r, `${ctx}.action: dbQuery requires "query" (string)`);
    }
    checkFieldTypes(
      action,
      { params: 'object', timeout: 'integer' },
      `${ctx}.action`,
      r,
    );
  } else if (action.type === 'wait') {
    checkUnknownKeys(action, VALID_ACTION_KEYS.wait, `${ctx}.action`, r);
    if (
      typeof action.durationMs !== 'number' ||
      !Number.isInteger(action.durationMs) ||
      action.durationMs <= 0
    ) {
      err(r, `${ctx}.action: wait requires positive integer "durationMs"`);
    }
  } else if (action.type === 'ui') {
    checkUnknownKeys(action, VALID_ACTION_KEYS.ui, `${ctx}.action`, r);
    validateUiAction(action, `${ctx}.action`, r);
  } else if (action.type === 'parallel') {
    checkUnknownKeys(action, VALID_ACTION_KEYS.parallel, `${ctx}.action`, r);
    if (!Array.isArray(action.actions)) {
      err(r, `${ctx}.action: parallel requires "actions" array`);
    } else {
      // Validate each sub-action as if it were a step's action
      for (let ai = 0; ai < action.actions.length; ai++) {
        const subAction = action.actions[ai] as Record<string, unknown>;
        validateStep(
          { action: subAction } as Record<string, unknown>,
          `${ctx}.action.actions[${ai}]`,
          r,
        );
        // The test agent runs each sub-action once
        for (const loop of ['forEach', 'for', 'repeat']) {
          if (subAction && typeof subAction === 'object' && loop in subAction) {
            err(
              r,
              `${ctx}.action.actions[${ai}]: "${loop}" can't be used inside parallel — loop the step instead`,
            );
          }
        }
      }
      // The test agent runs only httpRequest and dbQuery inside parallel
      for (let ai = 0; ai < action.actions.length; ai++) {
        const subType = (action.actions[ai] as Record<string, unknown>)?.type;
        if (subType === 'wait' || subType === 'ui') {
          err(
            r,
            `${ctx}.action.actions[${ai}]: "${subType}" can't run inside parallel — put it in its own step`,
          );
        }
      }
    }
  } else if (action.type) {
    err(
      r,
      `${ctx}.action: unknown action type "${action.type}" — expected httpRequest, dbQuery, wait, ui or parallel`,
    );
  } else {
    err(r, `${ctx}.action: missing "type"`);
  }

  // Validate loop modifiers on the step itself.
  validateLoopModifiers(step, ctx, r);
  validateLoopSiblingConflicts(step, ctx, r);

  // Validate loop modifiers on the action (action-level loops).
  if (action.type !== 'parallel' && action.type !== 'ui') {
    validateLoopModifiers(action, `${ctx}.action`, r);
  }

  if (action.type === 'parallel') {
    if (step.extract !== undefined) {
      warn(
        r,
        `${ctx}: "extract" on a parallel step will always receive an empty response — parallel actions do not produce an extraction document`,
      );
    }
    if (
      Array.isArray(step.assertions) &&
      step.assertions.some(
        (b: unknown) =>
          typeof b === 'object' &&
          b !== null &&
          !('match' in (b as Record<string, unknown>)),
      )
    ) {
      warn(
        r,
        `${ctx}: self-block assertions on a parallel step will always receive an empty response — use "match" blocks to assert against individual sub-action traffic`,
      );
    }
  }

  if (step.extract !== undefined) {
    validateExtractRules(step.extract, ctx, r);
  }

  if (step.assertions !== undefined) {
    if (!Array.isArray(step.assertions)) {
      err(r, `${ctx}: "assertions" must be an array`);
    } else {
      for (let ai = 0; ai < step.assertions.length; ai++) {
        const block = step.assertions[ai] as Record<string, unknown>;
        if (!block || typeof block !== 'object' || Array.isArray(block)) {
          err(r, `${ctx}.assertions[${ai}]: must be an object`);
          continue;
        }
        validateAssertionBlock(block, `${ctx}.assertions[${ai}]`, r);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tests validation
// ---------------------------------------------------------------------------

export function validateTests(
  tests: unknown,
  r: ValidationResult,
  filePath: string,
  fs: FileSystem,
): void {
  if (!Array.isArray(tests)) {
    err(r, '"tests" must be an array of test definitions');
    return;
  }
  if (tests.length === 0) {
    err(r, 'a definition needs at least one test');
    return;
  }

  // Screenshots are stored per definition, as screenshot/<name>.png
  const screenshotNames = new Map<string, string>();

  for (let ti = 0; ti < tests.length; ti++) {
    const test = tests[ti] as Record<string, unknown>;
    const ctx = `tests[${ti}]`;

    if (!test || typeof test !== 'object') {
      err(r, `${ctx}: must be an object`);
      continue;
    }

    if (typeof test.name !== 'string' || test.name.length === 0) {
      err(r, `${ctx}: missing or empty "name"`);
    }
    checkFieldTypes(
      test,
      { description: 'string', stopOnFailure: 'boolean' },
      ctx,
      r,
    );

    const { timeoutSeconds, ...knownTestKeys } = test;
    if (timeoutSeconds !== undefined) {
      err(
        r,
        `${ctx}: "timeoutSeconds" is not supported on a test — use config.timeoutSeconds for the run`,
      );
    }
    checkUnknownKeys(knownTestKeys, VALID_TEST_KEYS, ctx, r);

    validateVariablesField(test.variables, ctx, filePath, r, fs);

    // Validate loop modifiers on the test itself.
    validateLoopModifiers(test, ctx, r, { level: 'test' });

    if (test.steps === undefined) {
      err(r, `${ctx}: a test needs "steps"`);
    } else if (!Array.isArray(test.steps)) {
      err(r, `${ctx}: "steps" must be an array`);
    } else if (test.steps.length === 0) {
      err(r, `${ctx}: a test needs at least one step`);
    } else {
      for (let si = 0; si < test.steps.length; si++) {
        validateStep(
          test.steps[si] as Record<string, unknown>,
          `${ctx}.steps[${si}]`,
          r,
        );
      }

      // Warn if test-level repeat has until but the last step is a wait action,
      // since until evaluates against the last step's response (which is nil for wait).
      if (
        test.repeat !== undefined &&
        typeof test.repeat === 'object' &&
        !Array.isArray(test.repeat) &&
        (test.repeat as Record<string, unknown>).until !== undefined
      ) {
        const lastStep = test.steps[test.steps.length - 1] as Record<
          string,
          unknown
        >;
        const action = lastStep?.action as Record<string, unknown> | undefined;
        if (action?.type === 'wait') {
          warn(
            r,
            `${ctx}: test-level "repeat.until" evaluates against the last step's response, but the last step is a "wait" action (which produces no response) — the until condition will never match a $.response.* path`,
          );
        }
      }

      // Cross-step uniqueness for artifact names. The artifact pipeline
      // writes user-named captures to <type>/<name>.<ext> under the
      // instance directory; two captures sharing a name within one test
      // would silently overwrite each other in storage. Covers both plain
      // screenshot primitives and visualMatch captures (same folder).
      validateScreenshotNameUniqueness(test.steps, ctx, screenshotNames, r);
    }
  }
}

/**
 * seen: name → first location, across the definition's tests. Screenshots
 * are stored as screenshot/<name>.png per definition; two captures sharing a
 * name would overwrite each other (and make the baseline lookup ambiguous
 * when `match` is set).
 */
function validateScreenshotNameUniqueness(
  steps: unknown,
  ctx: string,
  seen: Map<string, string>,
  r: ValidationResult,
): void {
  if (!Array.isArray(steps)) {
    return;
  }
  for (let si = 0; si < steps.length; si++) {
    const step = steps[si] as {
      action?: { type?: string; steps?: unknown[] };
    };
    if (step?.action?.type !== 'ui' || !Array.isArray(step.action.steps)) {
      continue;
    }
    for (let subI = 0; subI < step.action.steps.length; subI++) {
      const sub = step.action.steps[subI] as Record<string, unknown>;
      if (!sub || typeof sub !== 'object') {
        continue;
      }
      const name = extractScreenshotName(sub);
      if (!name) {
        continue;
      }
      const here = `${ctx}.steps[${si}].action.steps[${subI}]`;
      const prior = seen.get(name);
      if (prior) {
        err(
          r,
          `${here}: duplicate screenshot name "${name}" — also used at ${prior}. Each screenshot name must be unique within a definition (screenshots are stored as screenshot/<name>.png and would overwrite each other).`,
        );
      } else {
        seen.set(name, here);
      }
    }
  }
}

/** Returns the screenshot's logical name in either wire form, or null. */
function extractScreenshotName(sub: Record<string, unknown>): string | null {
  if (typeof sub.screenshot === 'string' && sub.screenshot.length > 0) {
    return sub.screenshot;
  }
  if (
    sub.screenshot &&
    typeof sub.screenshot === 'object' &&
    !Array.isArray(sub.screenshot)
  ) {
    const obj = sub.screenshot as { name?: unknown };
    if (typeof obj.name === 'string' && obj.name.length > 0) {
      return obj.name;
    }
  }
  return null;
}
