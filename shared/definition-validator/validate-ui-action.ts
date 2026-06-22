import {
  VALID_UI_SUB_STEP_KEYS,
  VALID_UI_SUB_STEP_KEY_SET,
  VALID_UI_SUB_STEP_OPTIONAL_KEYS,
} from './constants';
import { ValidationResult, err, warn } from './validate-helpers';
import { validateLoopModifiers } from './validate-loops';
import {
  validateVisit,
  validateClick,
  validateType,
  validateWaitFor,
  validateExtract,
  validateScreenshot,
  validateScroll,
  validateSelect,
  validateHover,
  validateKey,
  validateUpload,
  validateDrag,
  validateViewport,
} from './validate-ui-substeps';

export { ARTIFACT_NAME_PATTERN } from './validate-ui-substeps';

// ---------------------------------------------------------------------------
// UI action top-level validation
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
