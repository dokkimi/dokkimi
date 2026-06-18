/** DNS label naming convention */
export const ITEM_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
export const ITEM_NAME_MAX_LENGTH = 63;
export const DEFINITION_NAME_MAX_LENGTH = 100;
export const DESCRIPTION_MAX_LENGTH = 500;

export const VALID_ITEM_TYPES = [
  'SERVICE',
  'DATABASE',
  'MOCK',
  'HTTP_REQUEST',
  'DB_QUERY',
] as const;
export type ItemType = (typeof VALID_ITEM_TYPES)[number];

export const VALID_DATABASES = [
  'postgres',
  'mysql',
  'mongodb',
  'redis',
] as const;

export const VALID_HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
] as const;

/** HTTP methods valid for MOCK items (includes wildcard) */
export const VALID_MOCK_METHODS = [...VALID_HTTP_METHODS, '*'] as const;

export const VALID_REQUEST_PROTOCOLS = ['http', 'https'] as const;

export const PORT_MIN = 1;
export const PORT_MAX = 65535;

export const MOCK_RESPONSE_STATUS_MIN = 100;
export const MOCK_RESPONSE_STATUS_MAX = 599;

// ---------------------------------------------------------------------------
// Valid key sets — used by the validator to warn on unknown properties
// ---------------------------------------------------------------------------

export const VALID_DEFINITION_KEYS = new Set([
  'name',
  'description',
  'items',
  'tests',
  'config',
  'variables',
]);

export const VALID_CONFIG_KEYS = new Set(['timeoutSeconds', 'browser']);

export const VALID_BROWSER_CONFIG_KEYS = new Set(['version']);

export const VALID_ITEM_KEYS: Record<string, Set<string>> = {
  SERVICE: new Set([
    'type',
    'name',
    'description',
    '$ref',
    'image',
    'port',
    'healthCheck',
    'uiPath',
    'debugPort',
    'env',
    'minCpu',
    'minMemory',
    'maxCpu',
    'maxMemory',
    'localDevPath',
    'mountPath',
  ]),
  DATABASE: new Set([
    'type',
    'name',
    'description',
    '$ref',
    'database',
    'version',
    'initFilePath',
    'initFilePaths',
    'initFileIds',
    'dbName',
    'dbUser',
    'dbPassword',
    'minCpu',
    'minMemory',
    'maxCpu',
    'maxMemory',
  ]),
  MOCK: new Set([
    'type',
    'name',
    'description',
    '$ref',
    'mockMethod',
    'mockOrigin',
    'mockTarget',
    'mockPath',
    'mockDelayMs',
    'mockResponseStatus',
    'mockRequestBodyContains',
    'mockRequestBodyMatches',
    'mockResponseHeaders',
    'mockResponseBody',
  ]),
  HTTP_REQUEST: new Set([
    'type',
    'name',
    'description',
    '$ref',
    'requestMethod',
    'requestProtocol',
    'requestUrl',
    'requestHeaders',
    'requestBody',
    'requestTarget',
  ]),
  DB_QUERY: new Set([
    'type',
    'name',
    'description',
    '$ref',
    'queryTarget',
    'queryText',
    'queryParams',
  ]),
};

export const VALID_TEST_KEYS = new Set([
  'name',
  'description',
  'timeoutSeconds',
  'stopOnFailure',
  'variables',
  'steps',
  'forEach',
  'for',
  'repeat',
]);

export const VALID_STEP_KEYS = new Set([
  'name',
  'description',
  'stopOnFailure',
  'action',
  'extract',
  'assertions',
  'forEach',
  'for',
  'repeat',
]);

export const VALID_ACTION_KEYS: Record<string, Set<string>> = {
  httpRequest: new Set([
    'type',
    'method',
    'url',
    'path',
    'headers',
    'body',
    'timeout',
    'forEach',
    'for',
    'repeat',
  ]),
  dbQuery: new Set([
    'type',
    'database',
    'query',
    'params',
    'timeout',
    'forEach',
    'for',
    'repeat',
  ]),
  wait: new Set(['type', 'durationMs', 'forEach', 'for', 'repeat']),
  ui: new Set(['type', 'target', 'steps']),
  parallel: new Set(['type', 'actions']),
};

// ---------------------------------------------------------------------------
// UI action sub-steps
//
// Each sub-step is an object with EXACTLY ONE discriminator key from the set
// below. The shape under that key is validated by validate-ui-action.ts.
// ---------------------------------------------------------------------------

export const VALID_UI_SUB_STEP_KEYS = [
  'visit',
  'click',
  'type',
  'waitFor',
  'extract',
  'screenshot',
  'scroll',
  'select',
  'hover',
  'key',
  'upload',
  'drag',
  'viewport',
] as const;

export type UiSubStepKind = (typeof VALID_UI_SUB_STEP_KEYS)[number];

export const VALID_UI_SUB_STEP_KEY_SET = new Set<string>(
  VALID_UI_SUB_STEP_KEYS,
);

/**
 * Optional sibling keys allowed alongside the kind discriminator on a UI
 * sub-step. e.g. `{ click: "...", timeoutMs: 5000 }`. Validated separately;
 * not flagged as unknown.
 */
export const VALID_UI_SUB_STEP_OPTIONAL_KEYS = new Set<string>(['timeoutMs']);

/** Shape of `type` sub-step: { type: { selector, text } } */
export const VALID_UI_TYPE_KEYS = new Set(['selector', 'text']);

/** Shape of object-form `waitFor` sub-step: { waitFor: { selector, text? } } */
export const VALID_UI_WAITFOR_OBJECT_KEYS = new Set(['selector', 'text']);

/** Shape of a single UI extract source (value under an extract variable name). */
export const VALID_UI_EXTRACT_SOURCE_KEYS = new Set([
  'from',
  'selector',
  'name',
  'key',
  'part',
  'pattern',
  'group',
]);

/** Values accepted for `from` in a UI extract source. */
export const VALID_UI_EXTRACT_FROM = [
  'text',
  'attribute',
  'value',
  'url',
  'cookie',
  'localStorage',
  'sessionStorage',
  'count',
  'exists',
] as const;

export type UiExtractFrom = (typeof VALID_UI_EXTRACT_FROM)[number];

/** Values accepted for `part` when `from: "url"`. */
export const VALID_UI_EXTRACT_URL_PARTS = [
  'full',
  'pathname',
  'search',
  'hash',
  'host',
] as const;

export type UiExtractUrlPart = (typeof VALID_UI_EXTRACT_URL_PARTS)[number];

export const VALID_ASSERTION_BLOCK_KEYS = new Set([
  'assertions',
  'match',
  'service',
  'consoleAssertions',
  'extract',
  'assertionScope',
  'count',
  'forEach',
  'for',
  'repeat',
]);

export const VALID_ASSERTION_KEYS = new Set([
  'path',
  'operator',
  'value',
  'disabled',
]);

export const VALID_ASSERTION_OPERATORS = [
  'eq',
  'eqIgnoreCase',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'containsIgnoreCase',
  'notContains',
  'notContainsIgnoreCase',
  'matches',
  'exists',
  'notExists',
  'in',
  'notIn',
  'type',
  'length',
  'isEmpty',
  'notEmpty',
  'arrayContains',
  'arrayNotContains',
] as const;

export const VALID_ASSERTION_SCOPES = ['all', 'first', 'last', 'any'] as const;

export const VALID_MATCH_CRITERIA_KEYS = new Set(['origin', 'method', 'url']);

export const VALID_COUNT_OPERATORS = ['eq', 'gte', 'lte', 'gt', 'lt'] as const;

export const VALID_COUNT_ASSERTION_KEYS = new Set(['operator', 'value']);

export const VALID_CONSOLE_LOG_ASSERTION_KEYS = new Set([
  'level',
  'message',
  'count',
  'disabled',
]);

export const VALID_CONSOLE_LOG_LEVELS = [
  'INFO',
  'WARN',
  'ERROR',
  'DEBUG',
] as const;

export const VALID_MESSAGE_FILTER_KEYS = new Set(['operator', 'value']);

export const VALID_MESSAGE_OPERATORS = [
  'eq',
  'contains',
  'containsIgnoreCase',
  'matches',
] as const;

// ---------------------------------------------------------------------------
// Loop modifier valid keys
// ---------------------------------------------------------------------------

export const VALID_FOR_EACH_KEYS = new Set(['items', 'as', 'name', 'delayMs']);
export const VALID_FOR_KEYS = new Set([
  'from',
  'to',
  'step',
  'as',
  'name',
  'delayMs',
]);
export const VALID_REPEAT_KEYS = new Set([
  'count',
  'as',
  'name',
  'delayMs',
  'until',
]);

export const VALID_EXTRACT_TRANSFORMS = ['keys', 'values', 'entries'] as const;
