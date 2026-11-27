/** DNS label naming convention */
export const ITEM_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
export const ITEM_NAME_MAX_LENGTH = 63;
export const DEFINITION_NAME_MAX_LENGTH = 100;
export const DESCRIPTION_MAX_LENGTH = 500;

export const VALID_ITEM_TYPES = [
  'SERVICE',
  'WORKER',
  'DATABASE',
  'BROKER',
  'MOCK',
] as const;
export type ItemType = (typeof VALID_ITEM_TYPES)[number];

export const VALID_DATABASES = [
  'postgres',
  'mysql',
  'mongodb',
  'redis',
] as const;

export const VALID_BROKERS = ['amqp', 'kafka'] as const;

/**
 * Ports the broker itself uses inside its container, which it shares with
 * the Dokkimi proxy listening on the item's `port`: Control Tower's
 * broker-config.service.ts (internal ports, Kafka's controller) and
 * RabbitMQ's epmd (4369) and distribution port (internal + 20000).
 */
export const BROKER_RESERVED_PORTS: Record<
  (typeof VALID_BROKERS)[number],
  number[]
> = {
  amqp: [4369, 10672, 30672],
  kafka: [9093, 19092],
};

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

export const PORT_MIN = 1;
export const PORT_MAX = 65535;

export const MOCK_RESPONSE_STATUS_MIN = 100;
export const MOCK_RESPONSE_STATUS_MAX = 599;

// ---------------------------------------------------------------------------
// Valid key sets — used by the validator to warn on unknown properties
// ---------------------------------------------------------------------------

export const VALID_DEFINITION_KEYS = new Set([
  // For editors; removed before the definition is submitted
  '$schema',
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
    'stage',
    'image',
    'port',
    'healthCheck',
    'env',
    'maxCpu',
    'maxMemory',
    'localDevPath',
    'mountPath',
    'command',
    'entrypoint',
    'mountFiles',
  ]),
  WORKER: new Set([
    'type',
    'name',
    'description',
    '$ref',
    'stage',
    'image',
    'env',
    'maxCpu',
    'maxMemory',
    'localDevPath',
    'mountPath',
    'command',
    'entrypoint',
    'mountFiles',
  ]),
  DATABASE: new Set([
    'type',
    'name',
    'description',
    '$ref',
    'stage',
    'database',
    'image',
    'version',
    'initFilePath',
    'initFilePaths',
    'initFileIds',
    'dbName',
    'dbUser',
    'dbPassword',
    'noAuth',
    'maxCpu',
    'maxMemory',
  ]),
  BROKER: new Set([
    'type',
    'name',
    'description',
    '$ref',
    'stage',
    'broker',
    'version',
    'image',
    'port',
    'healthCheck',
    'env',
    'command',
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
};

// Fields that were documented but never did anything. Using one is an
// error, so it isn't silently ignored.
export const REMOVED_ITEM_KEYS: Record<string, string> = {
  minCpu: 'Docker does not reserve resources; use maxCpu for a limit',
  minMemory: 'Docker does not reserve resources; use maxMemory for a limit',
  uiPath: 'it was never used; remove it',
};

export const VALID_TEST_KEYS = new Set([
  'name',
  'description',
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
    'formData',
    'queryParams',
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
  'extract',
  'forEach',
  'for',
  'repeat',
]);

export const VALID_ASSERTION_KEYS = new Set([
  'path',
  'count',
  'type',
  'keys',
  'values',
  'entries',
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
  'isEmpty',
  'notEmpty',
] as const;

export const VALID_MATCH_CRITERIA_KEYS = new Set([
  'path',
  'where',
  'count',
  'as',
]);

export const VALID_WHERE_ENTRY_KEYS = new Set([
  'path',
  'operator',
  'value',
  'or',
  'and',
  'not',
]);

export const VALID_TRANSFORMS = [
  'length',
  'type',
  'keys',
  'values',
  'entries',
] as const;

export const VALID_SOURCE_FIELDS = [
  'path',
  'count',
  'type',
  'keys',
  'values',
  'entries',
] as const;

export const VALID_COUNT_OPERATORS = ['eq', 'gte', 'lte', 'gt', 'lt'] as const;

export const VALID_COUNT_ASSERTION_KEYS = new Set(['operator', 'value']);

// ---------------------------------------------------------------------------
// Loop modifier valid keys
// ---------------------------------------------------------------------------

export const VALID_LOOP_BODY_KEYS = [
  'match',
  'assertions',
  'extract',
  'forEach',
  'for',
  'repeat',
  'action',
  'steps',
] as const;

export const VALID_FOR_EACH_KEYS = new Set([
  'items',
  'as',
  'name',
  'delayMs',
  ...VALID_LOOP_BODY_KEYS,
]);
export const VALID_FOR_KEYS = new Set([
  'from',
  'to',
  'step',
  'as',
  'name',
  'delayMs',
  ...VALID_LOOP_BODY_KEYS,
]);
export const VALID_REPEAT_KEYS = new Set([
  'count',
  'as',
  'name',
  'delayMs',
  'until',
  ...VALID_LOOP_BODY_KEYS,
]);

export const VALID_EXTRACT_TRANSFORMS = ['keys', 'values', 'entries'] as const;
