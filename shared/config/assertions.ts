/**
 * Test definition and assertion types for Dokkimi test validation.
 *
 * All assertions use the unified root context (`$.` prefix).
 * Match blocks filter collections with `where`-based filtering.
 * `$` is the scoped iterator inside `match.where` filters.
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

export interface LoopBody {
  match?: MatchCriteria;
  assertions?: Assertion[];
  extract?: Record<string, ExtractRule>;
  forEach?: ForEachLoop;
  for?: ForLoop;
  repeat?: RepeatLoop;
  action?: StepAction;
  steps?: TestStep[];
}

export interface ForEachLoop extends LoopBody {
  items: unknown[] | string;
  as: string;
  name?: string;
  delayMs?: number;
}

export interface ForLoop extends LoopBody {
  from: number;
  to: number;
  step?: number;
  as: string;
  name?: string;
  delayMs?: number;
}

export interface RepeatLoop extends LoopBody {
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
// MATCH CRITERIA
// ============================================

export interface MatchCriteria {
  path: string;
  where?: WhereEntry[];
  count?: number | CountAssertion;
  as?: string;
}

// ============================================
// WHERE ENTRIES
// ============================================

export type WhereEntry = WhereAssertion | WhereOr | WhereAnd | WhereNot;

export interface WhereAssertion {
  path: string;
  operator: AssertionOperator;
  value?: any;
}

export interface WhereOr {
  or: WhereEntry[];
}

export interface WhereAnd {
  and: WhereEntry[];
}

export interface WhereNot {
  not: WhereEntry;
}

// ============================================
// ASSERTION BLOCK
// ============================================

export interface AssertionBlock {
  extract?: Record<string, ExtractRule>;
  match?: MatchCriteria;
  assertions?: Assertion[];
  forEach?: ForEachLoop;
  for?: ForLoop;
  repeat?: RepeatLoop;
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
  | 'isEmpty'
  | 'notEmpty';

export interface PathWithTransform {
  from: string;
  transform?: 'length' | 'type' | 'keys' | 'values' | 'entries';
}

export interface ValueRef {
  from: string;
  transform?: 'length' | 'type' | 'keys' | 'values' | 'entries';
}

/**
 * A single assertion on a value located by a dotted path.
 *
 * Source resolution: exactly one of `path`, `count`, `type`, `keys`, `values`, `entries` must be set.
 * `path` can be a string (`$.response.body.id`) or a PathWithTransform object.
 * The shorthand fields (`count`, `type`, etc.) are sugar for `path` with a `transform`.
 */
export interface Assertion {
  path?: string | PathWithTransform;
  count?: string;
  type?: string;
  keys?: string;
  values?: string;
  entries?: string;
  operator: AssertionOperator;
  value?: any | ValueRef;
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
