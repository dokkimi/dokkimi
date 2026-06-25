export interface LatestRunResponse {
  runId: string;
  projectPath?: string | null;
  status: string;
  createdAt: string;
  completedAt: string | null;
  instances: InstanceSummary[];
}

export interface InstanceSummary {
  id: string;
  name: string;
  status: string;
  testStatus?: string;
  errorMessage?: string;
}

export interface ArtifactRow {
  id: string;
  instanceId: string;
  stepIndex: number;
  subStepIndex: number;
  type: 'screenshot' | 'diff' | 'html';
  name: string | null;
  uri: string;
  // Set on visualMatch CAPTURE rows after the post-run diff job: 'pass',
  // 'fail', or 'no-baseline'. Null for explicit screenshots, debug
  // captures, and pre-job-completion state.
  verdict: 'pass' | 'fail' | 'no-baseline' | null;
  createdAt: string;
}

export interface ArtifactsResponse {
  artifacts: ArtifactRow[];
}

export interface DefinitionSnapshotItem {
  name: string;
  type: 'SERVICE' | 'DATABASE' | 'MOCK';
  [key: string]: unknown;
}

export interface InstanceItemStatus {
  id: string;
  itemDefinitionName: string;
  status: string;
  readinessStatus: string | null;
}

export interface ConsoleLog {
  id: string;
  instanceId: string | null;
  instanceItemId: string | null;
  level: string;
  message: string;
  timestamp: string;
}

export interface ConsoleLogsResponse {
  logs: ConsoleLog[];
  total: number;
}

export interface InstanceDetail {
  id: string;
  items: InstanceItemStatus[];
}

export interface DefinitionSnapshot {
  name: string;
  items?: DefinitionSnapshotItem[];
  tests?: TestSuite[];
  [key: string]: unknown;
}

export interface TestSuite {
  name?: string;
  variables?: Record<string, unknown>;
  steps: TestStep[];
}

export interface TestStep {
  name?: string;
  action?: {
    type?: string;
    method?: string;
    url?: string;
    database?: string;
    query?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface HttpLog {
  id: string;
  method: string;
  url: string;
  statusCode: number | null;
  origin: string | null;
  target: string | null;
  requestBody: unknown;
  responseBody: unknown;
  requestHeaders: Record<string, unknown> | null;
  responseHeaders: Record<string, unknown> | null;
  isMocked: boolean | null;
  requestSentAt: string | null;
  responseReceivedAt: string | null;
  duration: number | null;
}

export interface HttpLogsResponse {
  logs: HttpLog[];
  total: number;
}

export interface DatabaseLog {
  id: string;
  instanceId: string;
  instanceItemId: string | null;
  databaseType: string;
  databaseName: string;
  query: string;
  params: Record<string, unknown> | null;
  success: boolean;
  data: Record<string, unknown>[] | null;
  rowsAffected: number | null;
  error: string | null;
  duration: number | null;
  timestamp: string;
}

export interface DatabaseLogsResponse {
  logs: DatabaseLog[];
  total: number;
}

export interface TestExecutionLog {
  id: string;
  instanceId: string;
  eventType: string;
  message: string;
  stepIndex: number | null;
  subActionIndex: number | null;
  subStepIndex: number | null;
  actionType: string | null;
  selector: string | null;
  duration: number | null;
  error: string | null;
  errorType: string | null;
  variables: Record<string, unknown>;
  timestamp: string;
}

export interface TestExecutionLogsResponse {
  logs: TestExecutionLog[];
  total: number;
}

export interface MessageLog {
  id: string;
  instanceId: string | null;
  instanceItemId: string | null;
  brokerType: string;
  brokerName: string;
  operation: string;
  body: unknown;
  contentType: string | null;
  metadata: Record<string, unknown> | null;
  timestamp: string;
}

export interface MessageLogsResponse {
  logs: MessageLog[];
  total: number;
}

// ---------------------------------------------------------------------------
// UI timeline — returned by GET /logs/ui-timeline/instance/:instanceId
// ---------------------------------------------------------------------------

/** One UI sub-step and its correlated downstream log events. */
export interface UiTimelineEntry {
  stepIndex: number | null;
  subStepIndex: number | null;
  action: string; // sub-step kind: visit / click / type / waitFor / extract / screenshot
  selector: string | null;
  message: string;
  startTimestamp: string;
  endTimestamp: string | null;
  durationMs: number | null;
  status: 'success' | 'failed' | 'in-progress';
  error: string | null;
  children: UiTimelineChild[];
}

export type UiTimelineChild = (
  | {
      kind: 'http';
      timestamp: string;
      method: string;
      url: string;
      statusCode: number | null;
      origin: string | null;
      target: string | null;
      isMocked: boolean | null;
    }
  | {
      kind: 'db';
      timestamp: string;
      databaseType: string;
      databaseName: string;
      query: string;
      success: boolean;
      durationMs: number | null;
    }
) & {
  /** Nested calls produced by this one (downstream HTTP / DB). */
  children: UiTimelineChild[];
};

export interface AssertionResult {
  id: string;
  instanceId: string;
  stepIndex: number;
  assertionIndex: number;
  assertionType: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
  error: string | null;
  path: string | null;
  operator: string | null;
  blockIndex: number | null;
  resultKind: string | null;
}

/** Flattened step group with global index for mapping to execution logs. */
export interface FlatStepGroup {
  globalIndex: number;
  testName: string;
  steps: TestStep[];
}

/** Actions available in the step detail view. */
export type StepDetailAction =
  | { kind: 'raw-step' }
  | { kind: 'test-logs' }
  | { kind: 'assertions' }
  | { kind: 'variables-before' }
  | { kind: 'variables-after' }
  | { kind: 'http-log'; log: HttpLog; index: number }
  | { kind: 'db-log'; log: DatabaseLog; index: number }
  | { kind: 'console-log'; itemName: string; instanceItemId: string }
  | { kind: 'ui-timeline' }
  | { kind: 'call-tree' }
  | { kind: 'screenshots' };
