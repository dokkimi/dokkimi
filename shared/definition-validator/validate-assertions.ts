import {
  VALID_ASSERTION_BLOCK_KEYS,
  VALID_ASSERTION_KEYS,
  VALID_ASSERTION_OPERATORS,
  VALID_ASSERTION_SCOPES,
  VALID_MATCH_CRITERIA_KEYS,
  VALID_COUNT_OPERATORS,
  VALID_COUNT_ASSERTION_KEYS,
  VALID_CONSOLE_LOG_ASSERTION_KEYS,
  VALID_CONSOLE_LOG_LEVELS,
  VALID_MESSAGE_FILTER_KEYS,
  VALID_MESSAGE_OPERATORS,
} from './constants';
import {
  ValidationResult,
  err,
  warn,
  checkUnknownKeys,
} from './validate-helpers';

// ---------------------------------------------------------------------------
// Count assertion
// ---------------------------------------------------------------------------

export function validateCountAssertion(
  count: unknown,
  ctx: string,
  r: ValidationResult,
): void {
  if (!count || typeof count !== 'object' || Array.isArray(count)) {
    err(r, `${ctx}: must be an object`);
    return;
  }
  const c = count as Record<string, unknown>;
  checkUnknownKeys(c, VALID_COUNT_ASSERTION_KEYS, ctx, r);
  if (
    !c.operator ||
    !VALID_COUNT_OPERATORS.includes(
      c.operator as (typeof VALID_COUNT_OPERATORS)[number],
    )
  ) {
    err(
      r,
      `${ctx}: operator must be one of: ${VALID_COUNT_OPERATORS.join(', ')}`,
    );
  }
  if (typeof c.value !== 'number' || !Number.isInteger(c.value)) {
    err(r, `${ctx}: value must be an integer`);
  }
}

// ---------------------------------------------------------------------------
// Console log assertion
// ---------------------------------------------------------------------------

export function validateConsoleLogAssertion(
  item: unknown,
  ctx: string,
  r: ValidationResult,
): void {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    err(r, `${ctx}: must be an object`);
    return;
  }
  const a = item as Record<string, unknown>;
  checkUnknownKeys(a, VALID_CONSOLE_LOG_ASSERTION_KEYS, ctx, r);

  if (a.level !== undefined) {
    if (
      !VALID_CONSOLE_LOG_LEVELS.includes(
        a.level as (typeof VALID_CONSOLE_LOG_LEVELS)[number],
      )
    ) {
      err(
        r,
        `${ctx}: level must be one of: ${VALID_CONSOLE_LOG_LEVELS.join(', ')}`,
      );
    }
  }
  if (a.message !== undefined) {
    if (
      !a.message ||
      typeof a.message !== 'object' ||
      Array.isArray(a.message)
    ) {
      err(r, `${ctx}: "message" must be an object`);
    } else {
      const m = a.message as Record<string, unknown>;
      checkUnknownKeys(m, VALID_MESSAGE_FILTER_KEYS, `${ctx}.message`, r);
      if (
        m.operator !== undefined &&
        !VALID_MESSAGE_OPERATORS.includes(
          m.operator as (typeof VALID_MESSAGE_OPERATORS)[number],
        )
      ) {
        err(
          r,
          `${ctx}.message: operator must be one of: ${VALID_MESSAGE_OPERATORS.join(', ')}`,
        );
      }
      if (m.value !== undefined && typeof m.value !== 'string') {
        err(r, `${ctx}.message: value must be a string`);
      }
    }
  }
  if (a.count !== undefined) {
    validateCountAssertion(a.count, `${ctx}.count`, r);
  }
}

// ---------------------------------------------------------------------------
// Extract rules
// ---------------------------------------------------------------------------

export function validateExtractRules(
  extract: unknown,
  ctx: string,
  r: ValidationResult,
): void {
  if (!extract || typeof extract !== 'object' || Array.isArray(extract)) {
    err(r, `${ctx}: "extract" must be an object`);
    return;
  }
  for (const [key, value] of Object.entries(
    extract as Record<string, unknown>,
  )) {
    if (typeof value === 'string') {
      // Simple JSONPath — valid
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const rule = value as Record<string, unknown>;
      const validKeys = new Set(['path', 'pattern', 'group']);
      for (const k of Object.keys(rule)) {
        if (!validKeys.has(k)) {
          warn(r, `${ctx}.extract["${key}"]: unknown key "${k}"`);
        }
      }
      if (typeof rule.path !== 'string' || !rule.path) {
        err(r, `${ctx}.extract["${key}"]: "path" must be a non-empty string`);
      }
      if (typeof rule.pattern !== 'string' || !rule.pattern) {
        err(
          r,
          `${ctx}.extract["${key}"]: "pattern" must be a non-empty string`,
        );
      } else {
        try {
          new RegExp(rule.pattern);
        } catch {
          err(r, `${ctx}.extract["${key}"]: "pattern" is not a valid regex`);
        }
      }
      if (rule.group !== undefined) {
        if (
          typeof rule.group !== 'number' ||
          !Number.isInteger(rule.group) ||
          rule.group < 0
        ) {
          err(
            r,
            `${ctx}.extract["${key}"]: "group" must be a non-negative integer`,
          );
        }
      }
    } else {
      err(
        r,
        `${ctx}.extract: value for "${key}" must be a string or { path, pattern, group? }`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Assertion block
// ---------------------------------------------------------------------------

export function validateAssertionBlock(
  block: Record<string, unknown>,
  ctx: string,
  r: ValidationResult,
): void {
  checkUnknownKeys(block, VALID_ASSERTION_BLOCK_KEYS, ctx, r);

  if (block.assertionScope !== undefined) {
    if (
      !VALID_ASSERTION_SCOPES.includes(
        block.assertionScope as (typeof VALID_ASSERTION_SCOPES)[number],
      )
    ) {
      err(
        r,
        `${ctx}: assertionScope must be one of: ${VALID_ASSERTION_SCOPES.join(', ')}`,
      );
    }
  }

  if (block.match !== undefined) {
    if (
      !block.match ||
      typeof block.match !== 'object' ||
      Array.isArray(block.match)
    ) {
      err(r, `${ctx}: "match" must be an object`);
    } else {
      const m = block.match as Record<string, unknown>;
      checkUnknownKeys(m, VALID_MATCH_CRITERIA_KEYS, `${ctx}.match`, r);
      if (typeof m.url === 'string' && /^[^/]+:\d+/.test(m.url)) {
        warn(
          r,
          `${ctx}.match: url "${m.url}" contains a port — ports are not needed and are likely to cause test failures`,
        );
      }
    }
  }

  if (block.count !== undefined) {
    validateCountAssertion(block.count, `${ctx}.count`, r);
  }

  if (block.extract !== undefined) {
    validateExtractRules(block.extract, ctx, r);
  }

  if (block.assertions !== undefined) {
    if (!Array.isArray(block.assertions)) {
      err(r, `${ctx}: "assertions" must be an array`);
    } else {
      for (let i = 0; i < block.assertions.length; i++) {
        const a = block.assertions[i] as Record<string, unknown>;
        if (a && typeof a === 'object') {
          checkUnknownKeys(
            a,
            VALID_ASSERTION_KEYS,
            `${ctx}.assertions[${i}]`,
            r,
          );
          if (
            a.operator !== undefined &&
            !VALID_ASSERTION_OPERATORS.includes(
              a.operator as (typeof VALID_ASSERTION_OPERATORS)[number],
            )
          ) {
            err(
              r,
              `${ctx}.assertions[${i}]: operator must be one of: ${VALID_ASSERTION_OPERATORS.join(', ')}`,
            );
          }
        }
      }
    }
  }

  if (block.consoleAssertions !== undefined) {
    if (!Array.isArray(block.consoleAssertions)) {
      err(r, `${ctx}: "consoleAssertions" must be an array`);
    } else {
      for (let i = 0; i < block.consoleAssertions.length; i++) {
        validateConsoleLogAssertion(
          block.consoleAssertions[i],
          `${ctx}.consoleAssertions[${i}]`,
          r,
        );
      }
    }
  }
}
