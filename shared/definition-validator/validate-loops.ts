import {
  VALID_FOR_EACH_KEYS,
  VALID_FOR_KEYS,
  VALID_REPEAT_KEYS,
  VALID_ASSERTION_KEYS,
  VALID_ASSERTION_OPERATORS,
} from './constants';
import { ValidationResult, err, checkUnknownKeys } from './validate-helpers';

/**
 * Validates that at most one loop modifier is present on an object.
 * Returns which modifier is set (or null if none).
 */
export function validateLoopModifiers(
  obj: Record<string, unknown>,
  ctx: string,
  r: ValidationResult,
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
      validateForEachLoop(obj.forEach, `${ctx}.forEach`, r);
      break;
    case 'for':
      validateForLoop(obj.for, `${ctx}.for`, r);
      break;
    case 'repeat':
      validateRepeatLoop(obj.repeat, `${ctx}.repeat`, r);
      break;
  }
  return modifier;
}

function validateForEachLoop(
  value: unknown,
  ctx: string,
  r: ValidationResult,
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
      // from == to with negative step is rejected: use step >= 1 (or omit) for single-iteration ranges.
      if (fl.step < 0 && fl.from <= fl.to) {
        err(r, `${ctx}: "from" must be > "to" when "step" is negative`);
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
        checkUnknownKeys(a, VALID_ASSERTION_KEYS, `${ctx}.until[${i}]`, r);
        if (typeof a.path !== 'string' || a.path.length === 0) {
          err(
            r,
            `${ctx}.until[${i}]: "path" is required and must be a non-empty string`,
          );
        }
        if (
          a.operator !== undefined &&
          !VALID_ASSERTION_OPERATORS.includes(
            a.operator as (typeof VALID_ASSERTION_OPERATORS)[number],
          )
        ) {
          err(
            r,
            `${ctx}.until[${i}]: operator must be one of: ${VALID_ASSERTION_OPERATORS.join(', ')}`,
          );
        }
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
  }
}
