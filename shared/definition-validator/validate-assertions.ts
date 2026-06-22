import {
  VALID_ASSERTION_BLOCK_KEYS,
  VALID_ASSERTION_KEYS,
  VALID_ASSERTION_OPERATORS,
  VALID_MATCH_CRITERIA_KEYS,
  VALID_COUNT_OPERATORS,
  VALID_COUNT_ASSERTION_KEYS,
  VALID_WHERE_ENTRY_KEYS,
  VALID_TRANSFORMS,
  VALID_SOURCE_FIELDS,
  VALID_EXTRACT_TRANSFORMS,
} from './constants';
import {
  validateLoopModifiers,
  validateBlockLoopSiblingConflicts,
} from './validate-loops';
import {
  ValidationResult,
  err,
  warn,
  checkUnknownKeys,
  validatePathFormat,
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
// Match count (accepts number shorthand or object)
// ---------------------------------------------------------------------------

function validateMatchCount(
  count: unknown,
  ctx: string,
  r: ValidationResult,
): void {
  if (typeof count === 'number') {
    if (!Number.isInteger(count) || count < 0) {
      err(r, `${ctx}: count must be a non-negative integer`);
    }
    return;
  }
  if (count && typeof count === 'object' && !Array.isArray(count)) {
    validateCountAssertion(count, ctx, r);
    return;
  }
  err(r, `${ctx}: count must be a number or {operator, value} object`);
}

// ---------------------------------------------------------------------------
// Where entry (recursive)
// ---------------------------------------------------------------------------

export function validateWhereEntry(
  entry: unknown,
  ctx: string,
  r: ValidationResult,
): void {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    err(r, `${ctx}: must be an object`);
    return;
  }
  const e = entry as Record<string, unknown>;
  checkUnknownKeys(e, VALID_WHERE_ENTRY_KEYS, ctx, r);

  const hasPath = e.path !== undefined;
  const hasOr = e.or !== undefined;
  const hasAnd = e.and !== undefined;
  const hasNot = e.not !== undefined;

  const formCount = [hasPath, hasOr, hasAnd, hasNot].filter(Boolean).length;
  if (formCount === 0) {
    err(r, `${ctx}: must have one of: path, or, and, not`);
    return;
  }
  if (formCount > 1 && !(hasPath && !hasOr && !hasAnd && !hasNot)) {
    err(r, `${ctx}: only one of path, or, and, not may be specified`);
    return;
  }

  if (hasPath) {
    if (typeof e.path !== 'string') {
      err(r, `${ctx}: path must be a string`);
    } else if (!e.path.startsWith('$$.')) {
      err(r, `${ctx}: where path must start with "$$." (scoped element)`);
    }
    if (
      e.operator !== undefined &&
      !VALID_ASSERTION_OPERATORS.includes(
        e.operator as (typeof VALID_ASSERTION_OPERATORS)[number],
      )
    ) {
      err(
        r,
        `${ctx}: operator must be one of: ${VALID_ASSERTION_OPERATORS.join(', ')}`,
      );
    }
  }

  if (hasOr) {
    if (!Array.isArray(e.or) || e.or.length === 0) {
      err(r, `${ctx}.or: must be a non-empty array`);
    } else {
      for (let i = 0; i < e.or.length; i++) {
        validateWhereEntry(e.or[i], `${ctx}.or[${i}]`, r);
      }
    }
  }

  if (hasAnd) {
    if (!Array.isArray(e.and) || e.and.length === 0) {
      err(r, `${ctx}.and: must be a non-empty array`);
    } else {
      for (let i = 0; i < e.and.length; i++) {
        validateWhereEntry(e.and[i], `${ctx}.and[${i}]`, r);
      }
    }
  }

  if (hasNot) {
    validateWhereEntry(e.not, `${ctx}.not`, r);
  }
}

// ---------------------------------------------------------------------------
// Match criteria
// ---------------------------------------------------------------------------

export function validateMatchCriteria(
  match: unknown,
  ctx: string,
  r: ValidationResult,
): void {
  if (!match || typeof match !== 'object' || Array.isArray(match)) {
    err(r, `${ctx}: "match" must be an object`);
    return;
  }
  const m = match as Record<string, unknown>;
  checkUnknownKeys(m, VALID_MATCH_CRITERIA_KEYS, `${ctx}`, r);

  if (typeof m.path !== 'string' || !m.path) {
    err(r, `${ctx}: "path" is required and must be a non-empty string`);
  } else if (!m.path.startsWith('$.')) {
    err(r, `${ctx}: path must start with "$."`);
  }

  if (m.where !== undefined) {
    if (!Array.isArray(m.where) || m.where.length === 0) {
      err(r, `${ctx}.where: must be a non-empty array`);
    } else {
      for (let i = 0; i < m.where.length; i++) {
        validateWhereEntry(m.where[i], `${ctx}.where[${i}]`, r);
      }
    }
  }

  if (m.count !== undefined) {
    validateMatchCount(m.count, `${ctx}.count`, r);
  }

  if (m.as !== undefined) {
    if (typeof m.as !== 'string' || !m.as) {
      err(r, `${ctx}: "as" must be a non-empty string`);
    }
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
      validatePathFormat(value, `${ctx}.extract["${key}"]`, r);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const rule = value as Record<string, unknown>;
      const eCtx = `${ctx}.extract["${key}"]`;

      const hasTransform = rule.transform !== undefined;
      const hasFrom = rule.from !== undefined;
      const hasPattern = rule.pattern !== undefined;

      if (hasTransform) {
        const validKeys = new Set(['path', 'from', 'transform']);
        for (const k of Object.keys(rule)) {
          if (!validKeys.has(k)) {
            warn(r, `${eCtx}: unknown key "${k}"`);
          }
        }
        if (hasPattern) {
          err(r, `${eCtx}: "transform" and "pattern" are mutually exclusive`);
        }
        if (hasFrom && rule.path !== undefined) {
          err(
            r,
            `${eCtx}: "from" and "path" are mutually exclusive in a transform rule`,
          );
        }
        if (
          !(VALID_EXTRACT_TRANSFORMS as readonly string[]).includes(
            rule.transform as string,
          )
        ) {
          err(
            r,
            `${eCtx}: "transform" must be one of: ${VALID_EXTRACT_TRANSFORMS.join(', ')}`,
          );
        }
        if (hasFrom) {
          if (typeof rule.from !== 'string' || !rule.from) {
            err(r, `${eCtx}: "from" must be a non-empty string`);
          }
        } else {
          if (typeof rule.path !== 'string' || !rule.path) {
            err(r, `${eCtx}: "path" must be a non-empty string`);
          } else {
            validatePathFormat(rule.path, eCtx, r);
          }
        }
      } else {
        const validKeys = new Set(['path', 'pattern', 'group']);
        for (const k of Object.keys(rule)) {
          if (!validKeys.has(k)) {
            warn(r, `${eCtx}: unknown key "${k}"`);
          }
        }
        if (typeof rule.path !== 'string' || !rule.path) {
          err(r, `${eCtx}: "path" must be a non-empty string`);
        } else {
          validatePathFormat(rule.path, eCtx, r);
        }
        if (typeof rule.pattern !== 'string' || !rule.pattern) {
          err(r, `${eCtx}: "pattern" must be a non-empty string`);
        } else {
          try {
            new RegExp(rule.pattern);
          } catch {
            err(r, `${eCtx}: "pattern" is not a valid regex`);
          }
        }
        if (rule.group !== undefined) {
          if (
            typeof rule.group !== 'number' ||
            !Number.isInteger(rule.group) ||
            rule.group < 0
          ) {
            err(r, `${eCtx}: "group" must be a non-negative integer`);
          }
        }
      }
    } else {
      err(
        r,
        `${ctx}.extract: value for "${key}" must be a string, { path, pattern, group? }, or { transform, path/from }`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Individual assertion
// ---------------------------------------------------------------------------

export function validateAssertion(
  a: Record<string, unknown>,
  ctx: string,
  r: ValidationResult,
): void {
  checkUnknownKeys(a, VALID_ASSERTION_KEYS, ctx, r);

  // Exactly one source field
  const sourceFields = (VALID_SOURCE_FIELDS as readonly string[]).filter(
    (f) => a[f] !== undefined,
  );
  if (sourceFields.length === 0) {
    err(
      r,
      `${ctx}: must have exactly one source field (${VALID_SOURCE_FIELDS.join(', ')})`,
    );
  } else if (sourceFields.length > 1) {
    err(
      r,
      `${ctx}: only one source field allowed, found: ${sourceFields.join(', ')}`,
    );
  }

  // Validate path field
  if (a.path !== undefined) {
    if (typeof a.path === 'string') {
      validatePathFormat(a.path, ctx, r);
    } else if (a.path && typeof a.path === 'object' && !Array.isArray(a.path)) {
      const pathObj = a.path as Record<string, unknown>;
      if (typeof pathObj.from !== 'string' || !pathObj.from) {
        err(r, `${ctx}.path: "from" must be a non-empty string`);
      } else {
        validatePathFormat(pathObj.from, `${ctx}.path.from`, r);
      }
      if (
        pathObj.transform !== undefined &&
        !(VALID_TRANSFORMS as readonly string[]).includes(
          pathObj.transform as string,
        )
      ) {
        err(
          r,
          `${ctx}.path: "transform" must be one of: ${VALID_TRANSFORMS.join(', ')}`,
        );
      }
    } else {
      err(r, `${ctx}: "path" must be a string or {from, transform?} object`);
    }
  }

  // Validate shorthand source fields (count, type, keys, values, entries)
  for (const field of ['count', 'type', 'keys', 'values', 'entries']) {
    if (a[field] !== undefined) {
      if (typeof a[field] !== 'string') {
        err(r, `${ctx}: "${field}" must be a string (path)`);
      } else {
        validatePathFormat(a[field] as string, `${ctx}.${field}`, r);
      }
    }
  }

  // Validate operator
  if (
    a.operator !== undefined &&
    !VALID_ASSERTION_OPERATORS.includes(
      a.operator as (typeof VALID_ASSERTION_OPERATORS)[number],
    )
  ) {
    err(
      r,
      `${ctx}: operator must be one of: ${VALID_ASSERTION_OPERATORS.join(', ')}`,
    );
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

  if (block.match !== undefined) {
    validateMatchCriteria(block.match, `${ctx}.match`, r);
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
          validateAssertion(a, `${ctx}.assertions[${i}]`, r);
        }
      }
    }
  }

  // Validate loop modifiers on assertion blocks (forEach, for, repeat)
  if (
    block.forEach !== undefined ||
    block.for !== undefined ||
    block.repeat !== undefined
  ) {
    validateLoopModifiers(block, ctx, r, {
      allowDocPaths: true,
      level: 'assertion-block',
    });
    validateBlockLoopSiblingConflicts(block, ctx, r);
  }
}
