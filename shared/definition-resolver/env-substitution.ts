const ENV_REF_RE = /\$\{\{(\w+)\}\}/g;

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
