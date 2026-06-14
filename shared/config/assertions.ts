/**
 * Test definition and assertion types for Dokkimi test validation.
 *
 * Assertion blocks are flat — no discriminated union, no "target" field.
 * TVS determines validation behavior from the block's shape:
 *   - No `match` → validate against the step's own HTTP request/response
 *   - Has `match` → filter HTTP logs by match criteria, validate against those
 *   - Has `service` → validate against console log output
 *
 * Assertions use a generic { path, operator, value } shape.
 * The `path` is a dotted path from the document root (e.g. "response.body.user.name",
 * "response.status", "data[0].email"). TVS assembles flat DB columns into a logical
 * document, then evaluates assertion paths against it.
 *
 * Structure:
 *   definition.tests: TestDefinition[]
 *   Each test has steps: TestStep[] (flat sequential list)
 *   Each step has: action + assertions (each assertion block can have extract)
 *   Parallel execution uses action type 'parallel' with nested actions[]
 */

// ============================================
// JSON VALUE TYPES
// ============================================

export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONObject
  | JSONArray;

export interface JSONObject {
  [key: string]: JSONValue;
}

export type JSONArray = JSONValue[];

// ============================================
// TEST DEFINITION
// ============================================

export interface TestDefinition {
  name: string;
  description?: string;
  timeoutSeconds?: number;
  stopOnFailure?: boolean;
  variables?: Record<string, string>;
  steps: TestStep[];
}

// ============================================
// TEST STEPS
// ============================================

export type TestStep = ActionTestStep;

/** A regex extract rule: resolve the JSONPath, then apply a regex pattern. */
export interface RegexExtractRule {
  path: string;
  pattern: string;
  /** Capture group index. Defaults to 1 when pattern is set. Use 0 for the full match. */
  group?: number;
}

/** An extract rule is either a plain JSONPath string or a regex extract object. */
export type ExtractRule = string | RegexExtractRule;

export interface ActionTestStep {
  name?: string;
  description?: string;
  stopOnFailure?: boolean;
  action: StepAction;
  extract?: Record<string, ExtractRule>;
  assertions?: AssertionBlock[];
}

// ============================================
// STEP ACTIONS
// ============================================

export type StepAction =
  | HttpRequestAction
  | DbQueryAction
  | WaitAction
  | ParallelAction;

export interface HttpRequestAction {
  type: 'httpRequest';
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: JSONValue;
  timeout?: number;
}

export interface DbQueryAction {
  type: 'dbQuery';
  database: string;
  query: string;
  params?: Record<string, any>;
  timeout?: number;
}

export interface WaitAction {
  type: 'wait';
  durationMs: number;
}

export interface ParallelAction {
  type: 'parallel';
  actions: StepAction[];
}

// ============================================
// ASSERTION BLOCK
// ============================================

export interface AssertionBlock {
  extract?: Record<string, ExtractRule>;

  /** When present, filter HTTP logs by these criteria instead of using the step's direct request. */
  match?: {
    origin?: string;
    method?: string;
    url?: string;
  };
  count?: CountAssertion;
  assertionScope?: 'all' | 'first' | 'last' | 'any';

  /** Generic assertions — each uses a dotted path to locate the value in the assembled document. */
  assertions: Assertion[];

  /** When present, validate against console log output for this service. */
  service?: string;
  consoleAssertions?: ConsoleLogAssertion[];
}

// ============================================
// GENERIC ASSERTION
// ============================================

export type AssertionOperator =
  | 'eq'
  | 'eqIgnoreCase'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'notContains'
  | 'matches'
  | 'exists'
  | 'notExists'
  | 'in'
  | 'notIn'
  | 'type'
  | 'length'
  | 'isEmpty'
  | 'notEmpty'
  | 'arrayContains'
  | 'arrayNotContains';

/**
 * A single assertion on a value located by a dotted path.
 *
 * The path is relative to the assembled document root:
 * - HTTP logs: "response.status", "response.body.user.name", "request.header.Authorization"
 * - DB query logs: "success", "data[0].email", "rowsAffected"
 * - Special: "responseTime" (computed from timing fields)
 */
export interface Assertion {
  path: string;
  operator: AssertionOperator;
  value?: any;
  disabled?: boolean;
}

// ============================================
// CONSOLE LOG ASSERTIONS
// ============================================

export interface ConsoleLogAssertion {
  level?: string;
  message?: {
    operator: 'eq' | 'contains' | 'matches';
    value: string;
  };
  count: CountAssertion;
  disabled?: boolean;
}

// ============================================
// SHARED TYPES
// ============================================

export interface CountAssertion {
  operator: 'eq' | 'gte' | 'lte' | 'gt' | 'lt';
  value: number;
}

// ============================================
// STEP EXECUTION
// ============================================

export interface StepExecution {
  stepIndex: number;
  startTime: string;
  endTime: string;
}

/** @deprecated Use StepExecution instead. */
export type GroupExecution = StepExecution;
