export const MAX_REF_DEPTH = 10;

export interface ValidationResult {
  file: string;
  kind: 'definition' | 'fragment' | 'invalid';
  errors: string[];
  warnings: string[];
}

/** Filesystem operations required by file-path-aware validators. */
export interface FileSystem {
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
}

export function err(r: ValidationResult, msg: string) {
  r.errors.push(msg);
}

export function warn(r: ValidationResult, msg: string) {
  r.warnings.push(msg);
}

export function checkUnknownKeys(
  obj: Record<string, unknown>,
  validKeys: Set<string>,
  ctx: string,
  r: ValidationResult,
): void {
  for (const key of Object.keys(obj)) {
    if (!validKeys.has(key)) {
      warn(r, `${ctx}: unknown property "${key}"`);
    }
  }
}
