export interface LatestRunResponse {
  runId: string;
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

export interface ConsoleLog {
  id: string;
  instanceId: string | null;
  instanceItemId: string | null;
  level: string;
  message: string;
  timestamp: string;
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
  variables: Record<string, string>;
  timestamp: string;
}

export interface PaginatedResponse<T> {
  logs: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface InstanceItemStatus {
  id: string;
  itemDefinitionName: string;
  status: string;
  readinessStatus: string | null;
}

export interface InstanceDetail {
  id: string;
  items: InstanceItemStatus[];
}
