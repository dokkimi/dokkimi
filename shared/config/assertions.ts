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
// LOOP MODIFIERS
// ============================================

export interface ForEachLoop {
  items: unknown[] | string;
  as: string;
  name?: string;
  delayMs?: number;
}

export interface ForLoop {
  from: number;
  to: number;
  step?: number;
  as: string;
  name?: string;
  delayMs?: number;
}

export interface RepeatLoop {
  count: number;
  as: string;
  name?: string;
  delayMs?: number;
  until?: Assertion[];
}

// ============================================
// TEST DEFINITION
// ============================================

export interface TestDefinition {
  name: string;
  description?: string;
  timeoutSeconds?: number;
  stopOnFailure?: boolean;
  variables?: Record<string, unknown>;
  steps: TestStep[];
  forEach?: ForEachLoop;
  for?: ForLoop;
  repeat?: RepeatLoop;
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

/** A transform extract rule: convert an object to an array for forEach iteration. */
export interface TransformExtractRule {
  path?: string;
  from?: string;
  transform: 'keys' | 'values' | 'entries';
}

/** An extract rule is either a plain JSONPath string, a regex extract object, or a transform rule. */
export type ExtractRule = string | RegexExtractRule | TransformExtractRule;

export interface ActionTestStep {
  name?: string;
  description?: string;
  stopOnFailure?: boolean;
  action: StepAction;
  extract?: Record<string, ExtractRule>;
  assertions?: AssertionBlock[];
  forEach?: ForEachLoop;
  for?: ForLoop;
  repeat?: RepeatLoop;
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
  forEach?: ForEachLoop;
  for?: ForLoop;
  repeat?: RepeatLoop;
}

export interface DbQueryAction {
  type: 'dbQuery';
  database: string;
  query: string;
  params?: Record<string, any>;
  timeout?: number;
  forEach?: ForEachLoop;
  for?: ForLoop;
  repeat?: RepeatLoop;
}

export interface WaitAction {
  type: 'wait';
  durationMs: number;
  forEach?: ForEachLoop;
  for?: ForLoop;
  repeat?: RepeatLoop;
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

  /** forEach on an assertion block iterates over an array and runs assertions per element. */
  forEach?: ForEachLoop;
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
  | 'containsIgnoreCase'
  | 'notContainsIgnoreCase'
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
 * Paths use the unified root context (prefix with "$."):
 * - HTTP: "$.response.status", "$.response.body.user.name", "$.request.headers.authorization"
 * - DB:   "$.response.success", "$.response.data[0].email", "$.response.rowsAffected"
 * - Variables: "$.variables.myVar"
 * - Timing: "$.responseTime"
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
    operator: 'eq' | 'contains' | 'containsIgnoreCase' | 'matches';
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
