const ENV_REF_RE = /\$\{\{(\w+)\}\}/g;
const VAR_REF_RE = /(?<!\$)\{\{([\w-]+)\}\}/g;
const LEFTOVER_VAR_RE = /(?<!\$)\{\{.+?\}\}/g;

/**
 * Recursively walks a value and replaces ${{KEY}} placeholders in strings
 * with matching env values. Collects any unresolved references as errors.
 */
export function interpolateEnv<T>(
  value: T,
  env: Record<string, string>,
  unresolved: Set<string>,
): T {
  if (typeof value === 'string') {
    return value.replace(ENV_REF_RE, (match, varName) => {
      if (varName in env) {
        return env[varName];
      }
      unresolved.add(varName);
      return match;
    }) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      interpolateEnv(item, env, unresolved),
    ) as unknown as T;
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = interpolateEnv(v, env, unresolved);
    }
    return result as T;
  }

  return value;
}

/**
 * Recursively walks a value and replaces {{KEY}} placeholders in strings
 * with matching variable values. Collects any unresolved simple references.
 */
export function interpolateVars<T>(
  value: T,
  vars: Record<string, string>,
  unresolved: Set<string>,
): T {
  if (typeof value === 'string') {
    return value.replace(VAR_REF_RE, (match, varName) => {
      if (varName in vars) {
        return vars[varName];
      }
      unresolved.add(varName);
      return match;
    }) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      interpolateVars(item, vars, unresolved),
    ) as unknown as T;
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = interpolateVars(v, vars, unresolved);
    }
    return result as T;
  }

  return value;
}

/**
 * Scans a value tree for any remaining {{...}} patterns after interpolateVars
 * has resolved simple keys. Catches dotted paths, array indexing, and other
 * complex references that are not valid in item fields.
 */
export function findLeftoverVarRefs(value: unknown): string[] {
  const leftovers: string[] = [];

  function walk(v: unknown): void {
    if (typeof v === 'string') {
      const matches = v.match(LEFTOVER_VAR_RE);
      if (matches) {
        leftovers.push(...matches);
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        walk(item);
      }
      return;
    }
    if (v && typeof v === 'object') {
      for (const val of Object.values(v)) {
        walk(val);
      }
    }
  }

  walk(value);
  return leftovers;
}
