import {
  VALID_UI_SUB_STEP_KEYS,
  VALID_UI_SUB_STEP_KEY_SET,
  VALID_UI_SUB_STEP_OPTIONAL_KEYS,
  VALID_UI_TYPE_KEYS,
  VALID_UI_WAITFOR_OBJECT_KEYS,
  VALID_UI_EXTRACT_SOURCE_KEYS,
  VALID_UI_EXTRACT_FROM,
  VALID_UI_EXTRACT_URL_PARTS,
  UiExtractFrom,
} from './constants';
import {
  ValidationResult,
  err,
  warn,
  checkUnknownKeys,
} from './validate-helpers';
import { validateLoopModifiers } from './validate-loops';

// ---------------------------------------------------------------------------
// UI action top-level validation
//
// An action of type "ui" looks like:
//   { type: "ui", target: "frontend-svc", steps: [ ...sub-steps ] }
//
// This module validates the `target` and the `steps` array. Each sub-step is
// an object with exactly ONE discriminator key (visit / click / type /
// waitFor / extract / screenshot); the shape under that key is validated by
// dispatch below.
// ---------------------------------------------------------------------------

export function validateUiAction(
  action: Record<string, unknown>,
  ctx: string,
  r: ValidationResult,
): void {
  if (typeof action.target !== 'string' || action.target.length === 0) {
    err(r, `${ctx}: ui action requires non-empty "target" (service name)`);
  }

  if (action.steps === undefined) {
    err(r, `${ctx}: ui action requires "steps" array`);
    return;
  }

  if (!Array.isArray(action.steps)) {
    err(r, `${ctx}: ui action "steps" must be an array`);
    return;
  }

  if (action.steps.length === 0) {
    warn(r, `${ctx}: ui action "steps" is empty — the action will do nothing`);
  }

  for (let i = 0; i < action.steps.length; i++) {
    validateUiSubStep(action.steps[i], `${ctx}.steps[${i}]`, r);
  }
}

// ---------------------------------------------------------------------------
// Sub-step dispatch
// ---------------------------------------------------------------------------

function validateUiSubStep(
  subStep: unknown,
  ctx: string,
  r: ValidationResult,
): void {
  if (!subStep || typeof subStep !== 'object' || Array.isArray(subStep)) {
    err(r, `${ctx}: must be an object`);
    return;
  }

  const obj = subStep as Record<string, unknown>;
  const keys = Object.keys(obj);

  // Detect sub-step groups: an entry with a loop modifier + "steps" array.
  const loopKeys = keys.filter(
    (k) => k === 'forEach' || k === 'for' || k === 'repeat',
  );
  if (loopKeys.length > 0 && obj.steps !== undefined) {
    // This is a sub-step group.
    const kindKeys = keys.filter((k) => VALID_UI_SUB_STEP_KEY_SET.has(k));
    if (kindKeys.length > 0) {
      err(
        r,
        `${ctx}: sub-step group cannot have both a loop modifier and a sub-step kind (${kindKeys.join(', ')})`,
      );
      return;
    }
    validateLoopModifiers(obj, ctx, r);
    if (!Array.isArray(obj.steps)) {
      err(r, `${ctx}: sub-step group "steps" must be an array`);
    } else {
      for (let i = 0; i < obj.steps.length; i++) {
        validateUiSubStep(obj.steps[i], `${ctx}.steps[${i}]`, r);
      }
    }
    return;
  }

  const kindKeys = keys.filter((k) => VALID_UI_SUB_STEP_KEY_SET.has(k));

  if (kindKeys.length === 0) {
    err(
      r,
      `${ctx}: missing sub-step kind — expected exactly one of: ${VALID_UI_SUB_STEP_KEYS.join(', ')}`,
    );
    return;
  }

  if (kindKeys.length > 1) {
    err(
      r,
      `${ctx}: sub-step has multiple kind keys (${kindKeys.join(', ')}); expected exactly one`,
    );
    return;
  }

  const unknownKeys = keys.filter(
    (k) =>
      !VALID_UI_SUB_STEP_KEY_SET.has(k) &&
      !VALID_UI_SUB_STEP_OPTIONAL_KEYS.has(k),
  );
  for (const k of unknownKeys) {
    warn(r, `${ctx}: unknown sub-step key "${k}"`);
  }

  // Optional per-sub-step timeout. Must be a positive integer (ms).
  if ('timeoutMs' in obj) {
    const t = obj.timeoutMs;
    if (
      typeof t !== 'number' ||
      !Number.isFinite(t) ||
      !Number.isInteger(t) ||
      t <= 0
    ) {
      err(r, `${ctx}.timeoutMs: must be a positive integer (milliseconds)`);
    }
  }

  const kind = kindKeys[0];
  const value = obj[kind];

  switch (kind) {
    case 'visit':
      validateVisit(value, ctx, r);
      return;
    case 'click':
      validateClick(value, ctx, r);
      return;
    case 'type':
      validateType(value, ctx, r);
      return;
    case 'waitFor':
      validateWaitFor(value, ctx, r);
      return;
    case 'extract':
      validateExtract(value, ctx, r);
      return;
    case 'screenshot':
      validateScreenshot(value, ctx, r);
      return;
    case 'scroll':
      validateScroll(value, ctx, r);
      return;
    case 'select':
      validateSelect(value, ctx, r);
      return;
    case 'hover':
      validateHover(value, ctx, r);
      return;
    case 'key':
      validateKey(value, ctx, r);
      return;
    case 'upload':
      validateUpload(value, ctx, r);
      return;
    case 'drag':
      validateDrag(value, ctx, r);
      return;
    case 'viewport':
      validateViewport(value, ctx, r);
      return;
  }
}

// ---------------------------------------------------------------------------
// Per-kind validators
// ---------------------------------------------------------------------------

function validateVisit(value: unknown, ctx: string, r: ValidationResult): void {
  if (typeof value !== 'string' || value.length === 0) {
    err(r, `${ctx}.visit: must be a non-empty string (path or URL)`);
  }
}

function validateClick(value: unknown, ctx: string, r: ValidationResult): void {
  if (typeof value !== 'string' || value.length === 0) {
    err(r, `${ctx}.click: must be a non-empty string (CSS selector)`);
  }
}

function validateType(value: unknown, ctx: string, r: ValidationResult): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    err(r, `${ctx}.type: must be an object { selector, text }`);
    return;
  }
  const obj = value as Record<string, unknown>;
  checkUnknownKeys(obj, VALID_UI_TYPE_KEYS, `${ctx}.type`, r);
  if (typeof obj.selector !== 'string' || obj.selector.length === 0) {
    err(r, `${ctx}.type: requires non-empty "selector" string`);
  }
  if (typeof obj.text !== 'string') {
    err(r, `${ctx}.type: requires "text" string`);
  }
}

function validateWaitFor(
  value: unknown,
  ctx: string,
  r: ValidationResult,
): void {
  if (typeof value === 'string') {
    if (value.length === 0) {
      err(r, `${ctx}.waitFor: selector string must not be empty`);
    }
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    err(
      r,
      `${ctx}.waitFor: must be a selector string or an object { selector, text? }`,
    );
    return;
  }
  const obj = value as Record<string, unknown>;
  checkUnknownKeys(obj, VALID_UI_WAITFOR_OBJECT_KEYS, `${ctx}.waitFor`, r);
  if (typeof obj.selector !== 'string' || obj.selector.length === 0) {
    err(r, `${ctx}.waitFor: requires non-empty "selector" string`);
  }
  if (obj.text !== undefined && typeof obj.text !== 'string') {
    err(r, `${ctx}.waitFor: "text" must be a string when provided`);
  }
}

// User-supplied artifact names (screenshot, eventually visualMatch) reach the
// filesystem as <name>.<ext>. Restrict to a safe alphabet so the name can't
// produce path traversal or weird filenames. Mirrors the regex on the CT-side
// upload DTO.
export const ARTIFACT_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Validates a `screenshot` sub-step. Accepts two forms:
 *   - String: `screenshot: "checkout-page"` — full-page capture, no diff.
 *   - Object: `screenshot: { name, selector?, match? }` — region-scoped
 *     capture and/or post-run baseline diff. The presence of `match`
 *     turns the capture into a visual-regression check against
 *     `.dokkimi/<project>/baselines/<name>.png`.
 */
function validateScreenshot(
  value: unknown,
  ctx: string,
  r: ValidationResult,
): void {
  // String short-form.
  if (typeof value === 'string') {
    if (value.length === 0) {
      err(
        r,
        `${ctx}.screenshot: must be a non-empty string (name/identifier for the capture)`,
      );
      return;
    }
    if (!ARTIFACT_NAME_PATTERN.test(value)) {
      err(
        r,
        `${ctx}.screenshot: name must match [a-zA-Z0-9_-]{1,64} (alphanumeric, dash, underscore; max 64 chars)`,
      );
    }
    return;
  }

  // Object form — name required, selector + match optional.
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    err(
      r,
      `${ctx}.screenshot: must be a name string or an object { name, selector?, match? }`,
    );
    return;
  }
  const v = value as Record<string, unknown>;

  if (typeof v.name !== 'string' || v.name.length === 0) {
    err(
      r,
      `${ctx}.screenshot.name: required, must be a non-empty string (artifact / baseline key)`,
    );
  } else if (!ARTIFACT_NAME_PATTERN.test(v.name)) {
    err(
      r,
      `${ctx}.screenshot.name: must match [a-zA-Z0-9_-]{1,64} (alphanumeric, dash, underscore; max 64 chars)`,
    );
  }

  if (
    v.selector !== undefined &&
    (typeof v.selector !== 'string' || v.selector.length === 0)
  ) {
    err(
      r,
      `${ctx}.screenshot.selector: when present, must be a non-empty string`,
    );
  }

  if (v.match !== undefined) {
    validateScreenshotMatch(v.match, `${ctx}.screenshot.match`, r);
  }
}

function validateScreenshotMatch(
  value: unknown,
  ctx: string,
  r: ValidationResult,
): void {
  // Polymorphic: boolean form (`match: true`) opts in with defaults;
  // boolean false is equivalent to omitting the key. Object form carries
  // overrides. Anything else is invalid.
  if (typeof value === 'boolean') {
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    err(
      r,
      `${ctx}: must be a boolean (true to opt in with defaults) or an object { threshold?, ignoreRegions? }`,
    );
    return;
  }
  const m = value as Record<string, unknown>;

  if (m.threshold !== undefined) {
    if (typeof m.threshold !== 'number' || !Number.isFinite(m.threshold)) {
      err(
        r,
        `${ctx}.threshold: must be a number between 0 and 1 (fraction of pixels allowed to differ)`,
      );
    } else if (m.threshold < 0 || m.threshold > 1) {
      err(r, `${ctx}.threshold: must be between 0 and 1 (got ${m.threshold})`);
    }
  }

  if (m.ignoreRegions !== undefined) {
    if (!Array.isArray(m.ignoreRegions)) {
      err(r, `${ctx}.ignoreRegions: must be an array of selector strings`);
    } else {
      for (let i = 0; i < m.ignoreRegions.length; i++) {
        const region = m.ignoreRegions[i];
        if (typeof region !== 'string' || region.length === 0) {
          err(
            r,
            `${ctx}.ignoreRegions[${i}]: must be a non-empty selector string`,
          );
        }
      }
    }
  }
}

function validateScroll(
  value: unknown,
  ctx: string,
  r: ValidationResult,
): void {
  // String form: scroll the matching element into view.
  if (typeof value === 'string') {
    if (value.length === 0) {
      err(r, `${ctx}.scroll: selector string must not be empty`);
    }
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    err(
      r,
      `${ctx}.scroll: must be a selector string or an object { selector?, x?, y? }`,
    );
    return;
  }
  const obj = value as Record<string, unknown>;
  checkUnknownKeys(obj, new Set(['selector', 'x', 'y']), `${ctx}.scroll`, r);
  const hasSelector =
    typeof obj.selector === 'string' && obj.selector.length > 0;
  const hasCoord = obj.x !== undefined || obj.y !== undefined;
  if (!hasSelector && !hasCoord) {
    err(
      r,
      `${ctx}.scroll: object form needs "selector" or at least one of "x"/"y"`,
    );
  }
  for (const k of ['x', 'y'] as const) {
    if (obj[k] !== undefined) {
      const v = obj[k];
      if (typeof v !== 'number' || !Number.isInteger(v)) {
        err(r, `${ctx}.scroll.${k}: must be an integer (pixel offset)`);
      }
    }
  }
}

function validateSelect(
  value: unknown,
  ctx: string,
  r: ValidationResult,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    err(r, `${ctx}.select: must be an object { selector, value }`);
    return;
  }
  const obj = value as Record<string, unknown>;
  checkUnknownKeys(obj, new Set(['selector', 'value']), `${ctx}.select`, r);
  if (typeof obj.selector !== 'string' || obj.selector.length === 0) {
    err(r, `${ctx}.select: requires non-empty "selector" string`);
  }
  if (typeof obj.value !== 'string') {
    err(r, `${ctx}.select: requires "value" string`);
  }
}

function validateHover(value: unknown, ctx: string, r: ValidationResult): void {
  if (typeof value !== 'string' || value.length === 0) {
    err(r, `${ctx}.hover: must be a non-empty CSS selector string`);
  }
}

function validateKey(value: unknown, ctx: string, r: ValidationResult): void {
  // String form: send to currently focused element.
  if (typeof value === 'string') {
    if (value.length === 0) {
      err(r, `${ctx}.key: key string must not be empty`);
    }
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    err(
      r,
      `${ctx}.key: must be a key-name string or an object { selector, key }`,
    );
    return;
  }
  const obj = value as Record<string, unknown>;
  checkUnknownKeys(obj, new Set(['selector', 'key']), `${ctx}.key`, r);
  if (typeof obj.key !== 'string' || obj.key.length === 0) {
    err(r, `${ctx}.key: requires non-empty "key" string`);
  }
  if (obj.selector !== undefined) {
    if (typeof obj.selector !== 'string' || obj.selector.length === 0) {
      err(r, `${ctx}.key: "selector" must be a non-empty string when provided`);
    }
  }
}

function validateUpload(
  value: unknown,
  ctx: string,
  r: ValidationResult,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    err(r, `${ctx}.upload: must be an object { selector, files }`);
    return;
  }
  const obj = value as Record<string, unknown>;
  checkUnknownKeys(obj, new Set(['selector', 'files']), `${ctx}.upload`, r);
  if (typeof obj.selector !== 'string' || obj.selector.length === 0) {
    err(r, `${ctx}.upload: requires non-empty "selector" string`);
  }
  if (!Array.isArray(obj.files) || obj.files.length === 0) {
    err(r, `${ctx}.upload: "files" must be a non-empty array of paths`);
    return;
  }
  for (let i = 0; i < obj.files.length; i++) {
    const f = obj.files[i];
    if (typeof f !== 'string' || f.length === 0) {
      err(
        r,
        `${ctx}.upload.files[${i}]: must be a non-empty string (path inside the test-agent container)`,
      );
    }
  }
}

function validateDrag(value: unknown, ctx: string, r: ValidationResult): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    err(r, `${ctx}.drag: must be an object { from, to }`);
    return;
  }
  const obj = value as Record<string, unknown>;
  checkUnknownKeys(obj, new Set(['from', 'to']), `${ctx}.drag`, r);
  if (typeof obj.from !== 'string' || obj.from.length === 0) {
    err(r, `${ctx}.drag: requires non-empty "from" CSS selector`);
  }
  if (typeof obj.to !== 'string' || obj.to.length === 0) {
    err(r, `${ctx}.drag: requires non-empty "to" CSS selector`);
  }
}

function validateViewport(
  value: unknown,
  ctx: string,
  r: ValidationResult,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    err(r, `${ctx}.viewport: must be an object { width, height }`);
    return;
  }
  const obj = value as Record<string, unknown>;
  checkUnknownKeys(obj, new Set(['width', 'height']), `${ctx}.viewport`, r);
  if (
    typeof obj.width !== 'number' ||
    !Number.isInteger(obj.width) ||
    obj.width <= 0
  ) {
    err(r, `${ctx}.viewport.width: must be a positive integer`);
  }
  if (
    typeof obj.height !== 'number' ||
    !Number.isInteger(obj.height) ||
    obj.height <= 0
  ) {
    err(r, `${ctx}.viewport.height: must be a positive integer`);
  }
}

// ---------------------------------------------------------------------------
// Extract validation
// ---------------------------------------------------------------------------

function validateExtract(
  value: unknown,
  ctx: string,
  r: ValidationResult,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    err(
      r,
      `${ctx}.extract: must be an object mapping variable names to source specs`,
    );
    return;
  }
  const obj = value as Record<string, unknown>;
  const entries = Object.entries(obj);
  if (entries.length === 0) {
    warn(r, `${ctx}.extract: has no variables defined`);
    return;
  }

  for (const [varName, source] of entries) {
    if (!/^\w+$/.test(varName)) {
      err(
        r,
        `${ctx}.extract: variable name "${varName}" must be alphanumeric (letters, digits, underscores)`,
      );
      continue;
    }
    validateExtractSource(source, `${ctx}.extract.${varName}`, r);
  }
}

function validateExtractSource(
  source: unknown,
  ctx: string,
  r: ValidationResult,
): void {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    err(r, `${ctx}: must be an object with a "from" field`);
    return;
  }
  const obj = source as Record<string, unknown>;
  checkUnknownKeys(obj, VALID_UI_EXTRACT_SOURCE_KEYS, ctx, r);

  const from = obj.from;
  if (typeof from !== 'string') {
    err(r, `${ctx}: missing "from" discriminator`);
    return;
  }
  if (!(VALID_UI_EXTRACT_FROM as readonly string[]).includes(from)) {
    err(
      r,
      `${ctx}: invalid "from" value "${from}" — must be one of: ${VALID_UI_EXTRACT_FROM.join(', ')}`,
    );
    return;
  }

  validateRequiredExtractFields(obj, from as UiExtractFrom, ctx, r);

  if (obj.pattern !== undefined && typeof obj.pattern !== 'string') {
    err(r, `${ctx}: "pattern" must be a string regex when provided`);
  } else if (typeof obj.pattern === 'string') {
    try {
      new RegExp(obj.pattern);
    } catch {
      err(r, `${ctx}: "pattern" is not a valid regex`);
    }
  }

  if (obj.group !== undefined) {
    if (
      typeof obj.group !== 'number' ||
      !Number.isInteger(obj.group) ||
      obj.group < 0
    ) {
      err(r, `${ctx}: "group" must be a non-negative integer when provided`);
    }
    if (obj.pattern === undefined) {
      warn(r, `${ctx}: "group" has no effect without "pattern"`);
    }
  }
}

function validateRequiredExtractFields(
  obj: Record<string, unknown>,
  from: UiExtractFrom,
  ctx: string,
  r: ValidationResult,
): void {
  const needsSelector = (key: string) => {
    if (typeof obj.selector !== 'string' || obj.selector.length === 0) {
      err(r, `${ctx}: from "${key}" requires non-empty "selector"`);
    }
  };

  switch (from) {
    case 'text':
    case 'value':
    case 'count':
    case 'exists':
      needsSelector(from);
      return;
    case 'attribute':
      needsSelector(from);
      if (typeof obj.name !== 'string' || obj.name.length === 0) {
        err(r, `${ctx}: from "attribute" requires non-empty "name"`);
      }
      return;
    case 'url':
      if (obj.part !== undefined) {
        if (typeof obj.part !== 'string') {
          err(r, `${ctx}: from "url" "part" must be a string when provided`);
        } else if (
          !(VALID_UI_EXTRACT_URL_PARTS as readonly string[]).includes(obj.part)
        ) {
          err(
            r,
            `${ctx}: from "url" invalid "part" "${obj.part}" — must be one of: ${VALID_UI_EXTRACT_URL_PARTS.join(', ')}`,
          );
        }
      }
      return;
    case 'cookie':
      if (typeof obj.name !== 'string' || obj.name.length === 0) {
        err(r, `${ctx}: from "cookie" requires non-empty "name"`);
      }
      return;
    case 'localStorage':
    case 'sessionStorage':
      if (typeof obj.key !== 'string' || obj.key.length === 0) {
        err(r, `${ctx}: from "${from}" requires non-empty "key"`);
      }
      return;
  }
}
