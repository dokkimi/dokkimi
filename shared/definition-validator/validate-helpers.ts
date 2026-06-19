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

// ---------------------------------------------------------------------------
// Path format validation (shared by assertions and loop until)
// ---------------------------------------------------------------------------

const DEPRECATED_PATH_PATTERNS: [RegExp, string][] = [
  [/^\$\.body\./, 'Did you mean "$.response.body."?'],
  [/^\$\.headers\./, 'Did you mean "$.response.headers."?'],
  [/^\$\.statusCode$/, 'Did you mean "$.response.status"?'],
  [/^\$\.extracted\./, 'Did you mean "$.variables."?'],
];

const OLD_PATH_SUGGESTIONS: [RegExp, string][] = [
  [/^response\.body\./, 'Did you mean "$.response.body."?'],
  [/^response\.status/, 'Did you mean "$.response.status"?'],
  [/^response\.headers?\./, 'Did you mean "$.response.headers."?'],
  [/^request\./, 'Did you mean "$.request."?'],
  [/^responseTime$/, 'Did you mean "$.responseTime"?'],
  [/^data\[/, 'Did you mean "$.response.data["?'],
  [/^success$/, 'Did you mean "$.response.success"?'],
  [/^rowsAffected$/, 'Did you mean "$.response.rowsAffected"?'],
  [/^error$/, 'Did you mean "$.response.error"?'],
  [/^duration$/, 'Did you mean "$.responseTime"?'],
];

export function validatePathFormat(
  pathValue: string,
  ctx: string,
  r: ValidationResult,
): void {
  if (pathValue.startsWith('{{')) {
    return;
  }

  for (const [pattern, msg] of DEPRECATED_PATH_PATTERNS) {
    if (pattern.test(pathValue)) {
      err(r, `${ctx}: path "${pathValue}" uses a deprecated format. ${msg}`);
      return;
    }
  }

  if (pathValue.startsWith('$.')) {
    return;
  }

  let suggestion = '';
  for (const [pattern, msg] of OLD_PATH_SUGGESTIONS) {
    if (pattern.test(pathValue)) {
      suggestion = ` ${msg}`;
      break;
    }
  }
  err(r, `${ctx}: path "${pathValue}" must start with "$.".${suggestion}`);
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
