import {
  VALID_DEFINITION_KEYS,
  VALID_CONFIG_KEYS,
  VALID_BROWSER_CONFIG_KEYS,
  DEFINITION_NAME_MAX_LENGTH,
} from './constants';
import {
  ValidationResult,
  FileSystem,
  err,
  warn,
  checkUnknownKeys,
} from './validate-helpers';
import { validateItem } from './validate-items';
import { resolveRefs } from './validate-refs';
import { validateTests, validateVariablesField } from './validate-tests';

// ---------------------------------------------------------------------------
// Top-level definition validation
// ---------------------------------------------------------------------------

export function validateDefinition(
  parsed: Record<string, unknown>,
  filePath: string,
  r: ValidationResult,
  fs: FileSystem,
): void {
  checkUnknownKeys(parsed, VALID_DEFINITION_KEYS, 'definition', r);

  if (typeof parsed.name !== 'string' || parsed.name.length === 0) {
    err(r, 'missing or empty "name"');
  } else if (parsed.name.length > DEFINITION_NAME_MAX_LENGTH) {
    err(r, `"name" exceeds ${DEFINITION_NAME_MAX_LENGTH} characters`);
  }

  if (!Array.isArray(parsed.items)) {
    err(r, '"items" must be an array');
    return;
  }

  if (parsed.items.length === 0) {
    warn(r, '"items" is empty — definition has no services or databases');
  }

  const resolvedItems = resolveRefs(parsed.items, filePath, r, fs);

  const itemNames = new Set<string>();
  for (let i = 0; i < resolvedItems.length; i++) {
    const { item, sourceFile } = resolvedItems[i];
    if (typeof item.name === 'string') {
      if (itemNames.has(item.name)) {
        err(r, `items[${i}]: duplicate item name "${item.name}"`);
      }
      itemNames.add(item.name);
    }
    validateItem(item, i, sourceFile, r, fs);
  }

  validateVariablesField(parsed.variables, 'definition', filePath, r, fs);

  if (parsed.tests !== undefined) {
    validateTests(parsed.tests, r, filePath, fs);
  }

  if (parsed.config !== undefined) {
    validateConfig(parsed.config, r);
  }
}

// ---------------------------------------------------------------------------
// Config block validation
// ---------------------------------------------------------------------------

function validateConfig(config: unknown, r: ValidationResult): void {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    err(r, '"config" must be a plain object');
    return;
  }

  const obj = config as Record<string, unknown>;
  checkUnknownKeys(obj, VALID_CONFIG_KEYS, 'config', r);

  if (obj.timeoutSeconds !== undefined) {
    if (
      typeof obj.timeoutSeconds !== 'number' ||
      !Number.isInteger(obj.timeoutSeconds) ||
      obj.timeoutSeconds <= 0
    ) {
      err(r, 'config.timeoutSeconds must be a positive integer');
    }
  }

  if (obj.browser !== undefined) {
    validateBrowserConfig(obj.browser, r);
  }
}

function validateBrowserConfig(browser: unknown, r: ValidationResult): void {
  if (
    typeof browser !== 'object' ||
    browser === null ||
    Array.isArray(browser)
  ) {
    err(r, 'config.browser must be a plain object');
    return;
  }

  const obj = browser as Record<string, unknown>;
  checkUnknownKeys(obj, VALID_BROWSER_CONFIG_KEYS, 'config.browser', r);

  if (obj.version !== undefined) {
    if (typeof obj.version !== 'string' || obj.version.length === 0) {
      err(r, 'config.browser.version must be a non-empty string');
    }
  }
}
