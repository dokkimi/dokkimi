import {
  VALID_FOR_EACH_KEYS,
  VALID_FOR_KEYS,
  VALID_REPEAT_KEYS,
} from './constants';
import { ValidationResult, err, checkUnknownKeys } from './validate-helpers';
import { validateAssertion } from './validate-assertions';

// ---------------------------------------------------------------------------
// Level-based loop body validation (Phase 13)
// ---------------------------------------------------------------------------

export type LoopLevel = 'test' | 'step' | 'assertion-block';

/** Maps each level to the set of body keys it allows (besides nested loops). */
const ALLOWED_BODY_KEYS: Record<LoopLevel, Set<string>> = {
  test: new Set(['steps']),
  step: new Set(['action', 'match', 'assertions', 'extract']),
  'assertion-block': new Set(['match', 'assertions', 'extract']),
};

/** Maps each level to the next (child) level for nested loops. */
const CHILD_LEVEL: Record<LoopLevel, LoopLevel | null> = {
  test: 'step',
  step: 'assertion-block',
  'assertion-block': null,
};

const LOOP_MODIFIER_KEYS = new Set(['forEach', 'for', 'repeat']);
const ALL_BODY_CONTENT_KEYS = new Set([
  'steps',
  'action',
  'match',
  'assertions',
  'extract',
]);

/**
 * Validates the body fields of a loop based on the level at which the loop
 * appears. Called by validateLoopModifiers when a level is specified.
 */
export function validateLoopBody(
  loopObj: Record<string, unknown>,
  ctx: string,
  r: ValidationResult,
  level: LoopLevel,
): void {
  const allowed = ALLOWED_BODY_KEYS[level];

  // Check for disallowed content keys
  for (const key of Object.keys(loopObj)) {
    if (ALL_BODY_CONTENT_KEYS.has(key) && !allowed.has(key)) {
      err(r, `${ctx}: "${key}" is not allowed in a ${level}-level loop body`);
    }
  }

  // Validate nested loops recursively
  const childLevel = CHILD_LEVEL[level];
  for (const loopKey of LOOP_MODIFIER_KEYS) {
    if (loopObj[loopKey] !== undefined) {
      if (childLevel === null) {
        err(
          r,
          `${ctx}: nested loops are not allowed inside an assertion-block-level loop`,
        );
      } else {
        // Recurse into the nested loop's body
        const nestedLoop = loopObj[loopKey];
        if (
          nestedLoop &&
          typeof nestedLoop === 'object' &&
          !Array.isArray(nestedLoop)
        ) {
          validateLoopBody(
            nestedLoop as Record<string, unknown>,
            `${ctx}.${loopKey}`,
            r,
            childLevel,
          );
        }
      }
    }
  }
}

/**
 * Validates that at most one loop modifier is present on an object.
 * Returns which modifier is set (or null if none).
 */
export interface LoopValidationOptions {
  allowDocPaths?: boolean;
  level?: LoopLevel;
}

export function validateLoopModifiers(
  obj: Record<string, unknown>,
  ctx: string,
  r: ValidationResult,
  options?: LoopValidationOptions,
): 'forEach' | 'for' | 'repeat' | null {
  const present: string[] = [];
  if (obj.forEach !== undefined) {
    present.push('forEach');
  }
  if (obj.for !== undefined) {
    present.push('for');
  }
  if (obj.repeat !== undefined) {
    present.push('repeat');
  }

  if (present.length === 0) {
    return null;
  }
  if (present.length > 1) {
    err(
      r,
      `${ctx}: only one loop modifier allowed; found ${present.join(', ')}`,
    );
    return null;
  }

  const modifier = present[0] as 'forEach' | 'for' | 'repeat';
  switch (modifier) {
    case 'forEach':
      validateForEachLoop(obj.forEach, `${ctx}.forEach`, r, options);
      break;
    case 'for':
      validateForLoop(obj.for, `${ctx}.for`, r);
      break;
    case 'repeat':
      validateRepeatLoop(obj.repeat, `${ctx}.repeat`, r);
      break;
  }

  // Level-based body validation
  const level = options?.level ?? 'step';
  const loopValue = obj[modifier];
  if (loopValue && typeof loopValue === 'object' && !Array.isArray(loopValue)) {
    validateLoopBody(
      loopValue as Record<string, unknown>,
      `${ctx}.${modifier}`,
      r,
      level,
    );
  }

  return modifier;
}

/**
 * At step level, `assertions` and `extract` must be inside the loop body,
 * never as siblings of the loop modifier (they would be silently overridden).
 * `action` is allowed as a sibling — the step's action is used per iteration
 * when the loop body has no action of its own.
 */
export function validateLoopSiblingConflicts(
  step: Record<string, unknown>,
  ctx: string,
  r: ValidationResult,
): void {
  for (const loopKey of LOOP_MODIFIER_KEYS) {
    const loopValue = step[loopKey];
    if (
      !loopValue ||
      typeof loopValue !== 'object' ||
      Array.isArray(loopValue)
    ) {
      continue;
    }
    if (step.assertions !== undefined) {
      err(
        r,
        `${ctx}: "assertions" must be inside "${loopKey}" body, not a sibling`,
      );
    }
    if (step.extract !== undefined) {
      err(
        r,
        `${ctx}: "extract" must be inside "${loopKey}" body, not a sibling`,
      );
    }
  }
}

/**
 * At test level, `steps` must be inside the loop body, never as a sibling.
 */
export function validateTestLoopSiblingConflicts(
  test: Record<string, unknown>,
  ctx: string,
  r: ValidationResult,
): void {
  for (const loopKey of LOOP_MODIFIER_KEYS) {
    const loopValue = test[loopKey];
    if (
      !loopValue ||
      typeof loopValue !== 'object' ||
      Array.isArray(loopValue)
    ) {
      continue;
    }
    if (test.steps !== undefined) {
      err(r, `${ctx}: "steps" must be inside "${loopKey}" body, not a sibling`);
    }
  }
}

/**
 * At assertion-block level, `assertions` must be inside the loop body,
 * never as a sibling.
 */
export function validateBlockLoopSiblingConflicts(
  block: Record<string, unknown>,
  ctx: string,
  r: ValidationResult,
): void {
  for (const loopKey of LOOP_MODIFIER_KEYS) {
    const loopValue = block[loopKey];
    if (
      !loopValue ||
      typeof loopValue !== 'object' ||
      Array.isArray(loopValue)
    ) {
      continue;
    }
    if (block.assertions !== undefined) {
      err(
        r,
        `${ctx}: "assertions" must be inside "${loopKey}" body, not a sibling`,
      );
    }
  }
}

function validateForEachLoop(
  value: unknown,
  ctx: string,
  r: ValidationResult,
  options?: LoopValidationOptions,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    err(r, `${ctx}: must be an object`);
    return;
  }
  const fe = value as Record<string, unknown>;
  checkUnknownKeys(fe, VALID_FOR_EACH_KEYS, ctx, r);

  if (fe.items === undefined) {
    err(r, `${ctx}: "items" is required`);
  } else if (!Array.isArray(fe.items) && typeof fe.items !== 'string') {
    err(
      r,
      `${ctx}: "items" must be an array or a string (variable reference or $ path)`,
    );
  } else if (
    typeof fe.items === 'string' &&
    fe.items.startsWith('$.') &&
    !options?.allowDocPaths
  ) {
    err(
      r,
      `${ctx}: "items" with a $.path is only supported on assertion-block forEach; use a {{variable}} reference instead`,
    );
  }

  validateAsField(fe.as, ctx, r);
  validateNameField(fe.name, ctx, r);
  validateDelayMs(fe.delayMs, ctx, r);
}

function validateForLoop(
  value: unknown,
  ctx: string,
  r: ValidationResult,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    err(r, `${ctx}: must be an object`);
    return;
  }
  const fl = value as Record<string, unknown>;
  checkUnknownKeys(fl, VALID_FOR_KEYS, ctx, r);

  if (typeof fl.from !== 'number' || !Number.isInteger(fl.from)) {
    err(r, `${ctx}: "from" must be an integer`);
  }
  if (typeof fl.to !== 'number' || !Number.isInteger(fl.to)) {
    err(r, `${ctx}: "to" must be an integer`);
  }

  if (fl.step !== undefined) {
    if (typeof fl.step !== 'number' || !Number.isInteger(fl.step)) {
      err(r, `${ctx}: "step" must be an integer`);
    } else if (fl.step === 0) {
      err(r, `${ctx}: "step" must not be 0`);
    } else if (typeof fl.from === 'number' && typeof fl.to === 'number') {
      if (fl.step > 0 && fl.from > fl.to) {
        err(r, `${ctx}: "from" must be <= "to" when "step" is positive`);
      }
      if (fl.step < 0 && fl.from < fl.to) {
        err(r, `${ctx}: "from" must be >= "to" when "step" is negative`);
      }
    }
  } else if (
    typeof fl.from === 'number' &&
    typeof fl.to === 'number' &&
    fl.from > fl.to
  ) {
    err(
      r,
      `${ctx}: "from" must be <= "to" (use negative "step" for descending ranges)`,
    );
  }

  if (
    typeof fl.from === 'number' &&
    typeof fl.to === 'number' &&
    typeof fl.step === 'number' &&
    fl.step !== 0
  ) {
    const count =
      fl.step > 0
        ? Math.floor((fl.to - fl.from) / fl.step) + 1
        : Math.floor((fl.from - fl.to) / -fl.step) + 1;
    if (count > 10000) {
      err(
        r,
        `${ctx}: for loop would produce ${count} iterations, which exceeds the 10,000 limit`,
      );
    }
  } else if (
    typeof fl.from === 'number' &&
    typeof fl.to === 'number' &&
    fl.step === undefined
  ) {
    const count = fl.to - fl.from + 1;
    if (count > 10000) {
      err(
        r,
        `${ctx}: for loop would produce ${count} iterations, which exceeds the 10,000 limit`,
      );
    }
  }

  validateAsField(fl.as, ctx, r);
  validateNameField(fl.name, ctx, r);
  validateDelayMs(fl.delayMs, ctx, r);
}

function validateRepeatLoop(
  value: unknown,
  ctx: string,
  r: ValidationResult,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    err(r, `${ctx}: must be an object`);
    return;
  }
  const rl = value as Record<string, unknown>;
  checkUnknownKeys(rl, VALID_REPEAT_KEYS, ctx, r);

  if (
    typeof rl.count !== 'number' ||
    !Number.isInteger(rl.count) ||
    rl.count <= 0
  ) {
    err(r, `${ctx}: "count" must be a positive integer`);
  }

  validateAsField(rl.as, ctx, r);
  validateNameField(rl.name, ctx, r);
  validateDelayMs(rl.delayMs, ctx, r);

  if (rl.until !== undefined) {
    if (!Array.isArray(rl.until)) {
      err(r, `${ctx}: "until" must be an array of assertions`);
    } else {
      for (let i = 0; i < rl.until.length; i++) {
        const a = rl.until[i] as Record<string, unknown>;
        if (!a || typeof a !== 'object') {
          err(r, `${ctx}.until[${i}]: must be an assertion object`);
          continue;
        }
        validateAssertion(a, `${ctx}.until[${i}]`, r);
      }
    }
  }
}

function validateAsField(
  value: unknown,
  ctx: string,
  r: ValidationResult,
): void {
  if (typeof value !== 'string' || value.length === 0) {
    err(r, `${ctx}: "as" is required and must be a non-empty string`);
  } else if (!/^\w+$/.test(value)) {
    err(r, `${ctx}: "as" must be alphanumeric (letters, digits, underscores)`);
  }
}

function validateNameField(
  value: unknown,
  ctx: string,
  r: ValidationResult,
): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'string' || value.length === 0) {
    err(r, `${ctx}: "name" must be a non-empty string`);
  } else if (!/^\w+$/.test(value)) {
    err(
      r,
      `${ctx}: "name" must be alphanumeric (letters, digits, underscores)`,
    );
  }
}

const MAX_DELAY_MS = 60000;

function validateDelayMs(
  value: unknown,
  ctx: string,
  r: ValidationResult,
): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    err(r, `${ctx}: "delayMs" must be a non-negative integer`);
  } else if (value > MAX_DELAY_MS) {
    err(
      r,
      `${ctx}: "delayMs" must not exceed ${MAX_DELAY_MS}ms (${MAX_DELAY_MS / 1000}s)`,
    );
  }
}
