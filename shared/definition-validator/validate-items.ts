import * as path from 'path';
import {
  ITEM_NAME_RE,
  ITEM_NAME_MAX_LENGTH,
  DESCRIPTION_MAX_LENGTH,
  VALID_ITEM_TYPES,
  VALID_DATABASES,
  VALID_HTTP_METHODS,
  VALID_MOCK_METHODS,
  VALID_REQUEST_PROTOCOLS,
  PORT_MIN,
  PORT_MAX,
  MOCK_RESPONSE_STATUS_MIN,
  MOCK_RESPONSE_STATUS_MAX,
  VALID_ITEM_KEYS,
} from './constants';
import {
  ValidationResult,
  FileSystem,
  err,
  warn,
  checkUnknownKeys,
} from './validate-helpers';

// ---------------------------------------------------------------------------
// Reusable field validators
// ---------------------------------------------------------------------------

function validateItemName(
  name: unknown,
  ctx: string,
  r: ValidationResult,
): void {
  if (typeof name !== 'string' || name.length === 0) {
    err(r, `${ctx}: missing or empty "name"`);
    return;
  }
  if (name.length > ITEM_NAME_MAX_LENGTH) {
    err(r, `${ctx}: name "${name}" exceeds ${ITEM_NAME_MAX_LENGTH} characters`);
  }
  if (!ITEM_NAME_RE.test(name)) {
    err(
      r,
      `${ctx}: name "${name}" must be lowercase alphanumeric with hyphens, starting/ending with alphanumeric`,
    );
  }
}

function validatePort(
  port: unknown,
  field: string,
  ctx: string,
  r: ValidationResult,
): void {
  if (port === undefined || port === null) {
    return;
  }
  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < PORT_MIN ||
    port > PORT_MAX
  ) {
    err(
      r,
      `${ctx}: ${field} must be an integer ${PORT_MIN}-${PORT_MAX}, got ${port}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Item-type validators
// ---------------------------------------------------------------------------

function validateServiceItem(
  item: Record<string, unknown>,
  label: string,
  r: ValidationResult,
): void {
  if (!item.image) {
    warn(r, `${label}: SERVICE should have "image"`);
  }
  if (!item.healthCheck || typeof item.healthCheck !== 'string') {
    err(r, `${label}: SERVICE requires "healthCheck" (string)`);
  }
  validatePort(item.port, 'port', label, r);
  validatePort(item.debugPort, 'debugPort', label, r);
  if (item.command !== undefined) {
    if (!Array.isArray(item.command)) {
      err(r, `${label}: "command" must be an array of strings`);
    } else {
      for (let i = 0; i < item.command.length; i++) {
        if (typeof item.command[i] !== 'string') {
          err(r, `${label}: command[${i}] must be a string`);
        }
      }
    }
  }
  if (item.env !== undefined) {
    if (!Array.isArray(item.env)) {
      err(r, `${label}: "env" must be an array`);
    } else {
      for (let i = 0; i < item.env.length; i++) {
        const e = item.env[i] as Record<string, unknown>;
        if (!e || typeof e.name !== 'string' || typeof e.value !== 'string') {
          err(r, `${label}: env[${i}] must have "name" and "value" strings`);
        }
      }
    }
  }
}

const DATABASE_VERSION_RE = /^\d[a-zA-Z0-9.-]*$/;

function validateDatabaseItem(
  item: Record<string, unknown>,
  label: string,
  sourceFile: string,
  r: ValidationResult,
  fs: FileSystem,
): void {
  if (
    !item.database ||
    !VALID_DATABASES.includes(item.database as (typeof VALID_DATABASES)[number])
  ) {
    err(
      r,
      `${label}: DATABASE requires "database" as one of: ${VALID_DATABASES.join(', ')}`,
    );
  }
  if (item.version !== undefined) {
    if (typeof item.version !== 'string' || item.version.length === 0) {
      err(r, `${label}: "version" must be a non-empty string`);
    } else if (!DATABASE_VERSION_RE.test(item.version)) {
      err(
        r,
        `${label}: "version" must start with a digit and contain only alphanumeric characters, dots, and hyphens (e.g. "16", "8.0", "7.2-alpine"; got "${item.version}")`,
      );
    }
  }
  if (item.initFilePath !== undefined) {
    validateInitFile(item.initFilePath as string, label, sourceFile, r, fs);
  }
  if (item.initFilePaths !== undefined) {
    if (!Array.isArray(item.initFilePaths)) {
      err(r, `${label}: "initFilePaths" must be an array`);
    } else {
      for (const fp of item.initFilePaths) {
        validateInitFile(fp as string, label, sourceFile, r, fs);
      }
    }
  }
}

function validateMockItem(
  item: Record<string, unknown>,
  label: string,
  r: ValidationResult,
): void {
  if (!item.mockTarget || typeof item.mockTarget !== 'string') {
    err(r, `${label}: MOCK requires "mockTarget" (string)`);
  }
  if (!item.mockPath || typeof item.mockPath !== 'string') {
    err(r, `${label}: MOCK requires "mockPath" (string)`);
  }
  if (item.mockMethod !== undefined) {
    const m = item.mockMethod as string;
    if (
      !VALID_MOCK_METHODS.includes(m as (typeof VALID_MOCK_METHODS)[number])
    ) {
      err(r, `${label}: mockMethod must be a valid HTTP method or "*"`);
    }
  }
  if (item.mockResponseStatus !== undefined) {
    const s = item.mockResponseStatus;
    if (
      typeof s !== 'number' ||
      !Number.isInteger(s) ||
      s < MOCK_RESPONSE_STATUS_MIN ||
      s > MOCK_RESPONSE_STATUS_MAX
    ) {
      err(
        r,
        `${label}: mockResponseStatus must be an integer ${MOCK_RESPONSE_STATUS_MIN}-${MOCK_RESPONSE_STATUS_MAX}`,
      );
    }
  }
  if (item.mockDelayMs !== undefined) {
    if (typeof item.mockDelayMs !== 'number' || item.mockDelayMs < 0) {
      err(r, `${label}: mockDelayMs must be a non-negative number`);
    }
  }
  if (item.mockRequestBodyContains !== undefined) {
    if (typeof item.mockRequestBodyContains !== 'string') {
      err(r, `${label}: mockRequestBodyContains must be a string`);
    } else if (item.mockRequestBodyContains.length === 0) {
      err(r, `${label}: mockRequestBodyContains must be non-empty`);
    }
  }
  if (item.mockRequestBodyMatches !== undefined) {
    if (typeof item.mockRequestBodyMatches !== 'string') {
      err(r, `${label}: mockRequestBodyMatches must be a string`);
    } else if (item.mockRequestBodyMatches.length === 0) {
      err(r, `${label}: mockRequestBodyMatches must be non-empty`);
    } else {
      try {
        new RegExp(item.mockRequestBodyMatches as string);
      } catch {
        err(r, `${label}: mockRequestBodyMatches is not a valid regex`);
      }
    }
  }
  if (
    item.mockRequestBodyContains !== undefined &&
    item.mockRequestBodyMatches !== undefined
  ) {
    err(
      r,
      `${label}: mockRequestBodyContains and mockRequestBodyMatches are mutually exclusive`,
    );
  }
}

function validateHttpRequestItem(
  item: Record<string, unknown>,
  label: string,
  r: ValidationResult,
): void {
  if (
    !item.requestMethod ||
    !VALID_HTTP_METHODS.includes(
      item.requestMethod as (typeof VALID_HTTP_METHODS)[number],
    )
  ) {
    err(r, `${label}: HTTP_REQUEST requires valid "requestMethod"`);
  }
  if (!item.requestUrl || typeof item.requestUrl !== 'string') {
    err(r, `${label}: HTTP_REQUEST requires "requestUrl" (string)`);
  }
  if (!item.requestTarget || typeof item.requestTarget !== 'string') {
    err(r, `${label}: HTTP_REQUEST requires "requestTarget" (string)`);
  }
  if (item.requestProtocol !== undefined) {
    if (
      !VALID_REQUEST_PROTOCOLS.includes(
        item.requestProtocol as (typeof VALID_REQUEST_PROTOCOLS)[number],
      )
    ) {
      err(
        r,
        `${label}: requestProtocol must be one of: ${VALID_REQUEST_PROTOCOLS.join(', ')}`,
      );
    }
  }
}

function validateDbQueryItem(
  item: Record<string, unknown>,
  label: string,
  r: ValidationResult,
): void {
  if (!item.queryTarget || typeof item.queryTarget !== 'string') {
    err(r, `${label}: DB_QUERY requires "queryTarget" (string)`);
  }
  if (!item.queryText || typeof item.queryText !== 'string') {
    err(r, `${label}: DB_QUERY requires "queryText" (string)`);
  }
}

// ---------------------------------------------------------------------------
// Init file validation
// ---------------------------------------------------------------------------

export function validateInitFile(
  filePath: string,
  ctx: string,
  sourceFile: string,
  r: ValidationResult,
  fs: FileSystem,
): void {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    err(r, `${ctx}: init file path must be a non-empty string`);
    return;
  }
  const resolved = path.resolve(path.dirname(sourceFile), filePath);
  if (!fs.existsSync(resolved)) {
    err(
      r,
      `${ctx}: init file not found: ${filePath} (resolved to ${resolved})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Top-level item validation
// ---------------------------------------------------------------------------

export function validateItem(
  item: Record<string, unknown>,
  index: number,
  sourceFile: string,
  r: ValidationResult,
  fs: FileSystem,
): void {
  const ctx = `items[${index}]`;

  if (
    !item.type ||
    !VALID_ITEM_TYPES.includes(item.type as (typeof VALID_ITEM_TYPES)[number])
  ) {
    err(r, `${ctx}: "type" must be one of: ${VALID_ITEM_TYPES.join(', ')}`);
    return;
  }

  validateItemName(item.name, ctx, r);
  const type = item.type as string;
  const label = `${ctx} (${item.name})`;

  if (
    item.description !== undefined &&
    typeof item.description === 'string' &&
    item.description.length > DESCRIPTION_MAX_LENGTH
  ) {
    warn(
      r,
      `${label}: description exceeds ${DESCRIPTION_MAX_LENGTH} characters`,
    );
  }

  const validKeys = VALID_ITEM_KEYS[type];
  if (validKeys) {
    checkUnknownKeys(item, validKeys, label, r);
  }

  switch (type) {
    case 'SERVICE':
      validateServiceItem(item, label, r);
      break;
    case 'DATABASE':
      validateDatabaseItem(item, label, sourceFile, r, fs);
      break;
    case 'MOCK':
      validateMockItem(item, label, r);
      break;
    case 'HTTP_REQUEST':
      validateHttpRequestItem(item, label, r);
      break;
    case 'DB_QUERY':
      validateDbQueryItem(item, label, r);
      break;
  }
}
