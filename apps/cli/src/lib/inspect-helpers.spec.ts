import {
  buildInstanceMenuItems,
  deriveGroupStatuses,
  deriveStepAssertionStatuses,
  rewriteErrorMessage,
  getGroupError,
  getGroupVariables,
  filterLogsByTimeWindow,
} from './inspect-helpers';
import type {
  TestExecutionLog,
  AssertionResult,
  FlatStepGroup,
  HttpLog,
  DefinitionSnapshot,
  InstanceSummary,
  InstanceItemStatus,
} from './inspect-types';
import type { MenuItem } from './menu';
import type { InstanceMenuAction } from './inspect-helpers';

// ---------------------------------------------------------------------------
// Helpers to build minimal test objects
// ---------------------------------------------------------------------------

function makeExecLog(
  overrides: Partial<TestExecutionLog> & { eventType: string },
): TestExecutionLog {
  const { eventType, ...rest } = overrides;
  return {
    id: 'log-1',
    instanceId: 'inst-1',
    eventType,
    message: '',
    stepIndex: null,
    subActionIndex: null,
    subStepIndex: null,
    actionType: null,
    selector: null,
    duration: null,
    error: null,
    errorType: null,
    variables: {},
    timestamp: new Date().toISOString(),
    ...rest,
  };
}

function makeAssertion(
  overrides: Partial<AssertionResult> & { stepIndex: number },
): AssertionResult {
  const { stepIndex, ...rest } = overrides;
  return {
    id: 'a-1',
    instanceId: 'inst-1',
    stepIndex,
    assertionIndex: 0,
    assertionType: 'response.statusCode',
    passed: true,
    expected: 200,
    actual: 200,
    error: null,
    path: null,
    operator: null,
    blockIndex: null,
    resultKind: null,
    ...rest,
  };
}

function makeHttpLog(overrides: Partial<HttpLog>): HttpLog {
  return {
    id: 'http-1',
    method: 'GET',
    url: '/api/test',
    statusCode: 200,
    origin: null,
    target: null,
    requestBody: null,
    responseBody: null,
    requestHeaders: null,
    responseHeaders: null,
    isMocked: null,
    requestSentAt: null,
    responseReceivedAt: null,
    duration: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// deriveGroupStatuses
// ---------------------------------------------------------------------------

describe('deriveGroupStatuses', () => {
  it('maps STEP_STARTED to RUNNING', () => {
    const logs = [makeExecLog({ eventType: 'STEP_STARTED', stepIndex: 0 })];
    const result = deriveGroupStatuses(logs, 1);
    expect(result.get(0)).toBe('RUNNING');
  });

  it('maps STEP_COMPLETED to PASSED', () => {
    const logs = [makeExecLog({ eventType: 'STEP_COMPLETED', stepIndex: 0 })];
    const result = deriveGroupStatuses(logs, 1);
    expect(result.get(0)).toBe('PASSED');
  });

  it('maps STEP_FAILED to FAILED', () => {
    const logs = [makeExecLog({ eventType: 'STEP_FAILED', stepIndex: 1 })];
    const result = deriveGroupStatuses(logs, 2);
    expect(result.get(1)).toBe('FAILED');
  });

  it('maps REQUEST_SKIPPED to SKIPPED', () => {
    const logs = [makeExecLog({ eventType: 'REQUEST_SKIPPED', stepIndex: 0 })];
    const result = deriveGroupStatuses(logs, 1);
    expect(result.get(0)).toBe('SKIPPED');
  });

  it('defaults to PENDING for groups with no logs', () => {
    const result = deriveGroupStatuses([], 3);
    expect(result.get(0)).toBe('PENDING');
    expect(result.get(1)).toBe('PENDING');
    expect(result.get(2)).toBe('PENDING');
  });

  it('handles empty logs', () => {
    const result = deriveGroupStatuses([], 0);
    expect(result.size).toBe(0);
  });

  it('last event wins for the same step', () => {
    const logs = [
      makeExecLog({ eventType: 'STEP_STARTED', stepIndex: 0 }),
      makeExecLog({ eventType: 'STEP_COMPLETED', stepIndex: 0 }),
    ];
    const result = deriveGroupStatuses(logs, 1);
    expect(result.get(0)).toBe('PASSED');
  });

  it('skips logs with null stepIndex', () => {
    const logs = [makeExecLog({ eventType: 'STEP_STARTED', stepIndex: null })];
    const result = deriveGroupStatuses(logs, 1);
    expect(result.get(0)).toBe('PENDING');
  });
});

// ---------------------------------------------------------------------------
// deriveStepAssertionStatuses
// ---------------------------------------------------------------------------

describe('deriveStepAssertionStatuses', () => {
  it('FAILED overrides any previous status for same step', () => {
    const assertions = [
      makeAssertion({ stepIndex: 0, passed: true }),
      makeAssertion({ stepIndex: 0, passed: false }),
    ];
    const result = deriveStepAssertionStatuses(assertions);
    expect(result.get('0')).toBe('FAILED');
  });

  it('PASSED only set if no existing entry', () => {
    const assertions = [makeAssertion({ stepIndex: 1, passed: true })];
    const result = deriveStepAssertionStatuses(assertions);
    expect(result.get('1')).toBe('PASSED');
  });

  it('PASSED does not override FAILED', () => {
    const assertions = [
      makeAssertion({ stepIndex: 0, passed: false }),
      makeAssertion({ stepIndex: 0, passed: true }),
    ];
    const result = deriveStepAssertionStatuses(assertions);
    expect(result.get('0')).toBe('FAILED');
  });

  it('SKIPPED only set if no existing entry', () => {
    const assertions = [
      makeAssertion({ stepIndex: 2, passed: true, resultKind: 'SKIPPED' }),
    ];
    const result = deriveStepAssertionStatuses(assertions);
    expect(result.get('2')).toBe('SKIPPED');
  });

  it('NOT_VALIDATED only set if no existing entry', () => {
    const assertions = [
      makeAssertion({
        stepIndex: 3,
        passed: true,
        resultKind: 'NOT_VALIDATED',
      }),
    ];
    const result = deriveStepAssertionStatuses(assertions);
    expect(result.get('3')).toBe('NOT_VALIDATED');
  });

  it('SKIPPED does not override existing status', () => {
    const assertions = [
      makeAssertion({ stepIndex: 0, passed: true }),
      makeAssertion({ stepIndex: 0, passed: true, resultKind: 'SKIPPED' }),
    ];
    const result = deriveStepAssertionStatuses(assertions);
    expect(result.get('0')).toBe('PASSED');
  });

  it('handles empty array', () => {
    const result = deriveStepAssertionStatuses([]);
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// rewriteErrorMessage
// ---------------------------------------------------------------------------

describe('rewriteErrorMessage', () => {
  const flatGroups: FlatStepGroup[] = [
    {
      globalIndex: 0,
      testName: 'Login Test',
      steps: [{ name: 'send login request' }],
    },
    {
      globalIndex: 1,
      testName: 'Signup Test',
      steps: [{ name: 'create user' }],
    },
  ];

  it('rewrites "step group N failed" to test name with step name', () => {
    const result = rewriteErrorMessage('step group 1 failed', flatGroups);
    expect(result).toBe('"Login Test" failed at "send login request"');
  });

  it('rewrites "step N failed" (without "group")', () => {
    const result = rewriteErrorMessage('step 2 failed', flatGroups);
    expect(result).toBe('"Signup Test" failed at "create user"');
  });

  it('keeps original text when group index out of range', () => {
    const result = rewriteErrorMessage('step group 99 failed', flatGroups);
    expect(result).toBe('step group 99 failed');
  });

  it('handles steps without names', () => {
    const groups: FlatStepGroup[] = [
      { globalIndex: 0, testName: 'My Test', steps: [{}] },
    ];
    const result = rewriteErrorMessage('step group 1 failed', groups);
    expect(result).toBe('"My Test" failed');
  });
});

// ---------------------------------------------------------------------------
// getGroupError
// ---------------------------------------------------------------------------

describe('getGroupError', () => {
  it('returns error from STEP_FAILED log for the given stepIndex', () => {
    const logs = [
      makeExecLog({
        eventType: 'STEP_FAILED',
        stepIndex: 2,
        error: 'assertion failed',
      }),
    ];
    expect(getGroupError(logs, 2)).toBe('assertion failed');
  });

  it('returns message when no error field', () => {
    const logs = [
      makeExecLog({
        eventType: 'STEP_FAILED',
        stepIndex: 0,
        error: null,
        message: 'step timed out',
      }),
    ];
    expect(getGroupError(logs, 0)).toBe('step timed out');
  });

  it('returns null when no STEP_FAILED log found', () => {
    const logs = [makeExecLog({ eventType: 'STEP_COMPLETED', stepIndex: 0 })];
    expect(getGroupError(logs, 0)).toBeNull();
  });

  it('returns null for different stepIndex', () => {
    const logs = [
      makeExecLog({
        eventType: 'STEP_FAILED',
        stepIndex: 1,
        error: 'wrong step',
      }),
    ];
    expect(getGroupError(logs, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getGroupVariables
// ---------------------------------------------------------------------------

describe('getGroupVariables', () => {
  it('returns before from previous step and after from this step', () => {
    const logs = [
      makeExecLog({
        eventType: 'STEP_COMPLETED',
        stepIndex: 0,
        variables: { token: 'abc' },
      }),
      makeExecLog({
        eventType: 'STEP_COMPLETED',
        stepIndex: 1,
        variables: { token: 'abc', userId: '42' },
      }),
    ];
    const result = getGroupVariables(logs, 1);
    expect(result.before).toEqual({ token: 'abc' });
    expect(result.after).toEqual({ token: 'abc', userId: '42' });
  });

  it('returns empty objects when no relevant logs', () => {
    const result = getGroupVariables([], 0);
    expect(result.before).toEqual({});
    expect(result.after).toEqual({});
  });

  it('uses STEP_FAILED for after variables', () => {
    const logs = [
      makeExecLog({
        eventType: 'STEP_FAILED',
        stepIndex: 0,
        variables: { x: '1' },
      }),
    ];
    const result = getGroupVariables(logs, 0);
    expect(result.after).toEqual({ x: '1' });
  });

  it('returns empty before when no previous step completed', () => {
    const logs = [
      makeExecLog({
        eventType: 'STEP_COMPLETED',
        stepIndex: 0,
        variables: { a: 'b' },
      }),
    ];
    const result = getGroupVariables(logs, 0);
    expect(result.before).toEqual({});
    expect(result.after).toEqual({ a: 'b' });
  });
});

// ---------------------------------------------------------------------------
// filterLogsByTimeWindow
// ---------------------------------------------------------------------------

describe('filterLogsByTimeWindow', () => {
  const t0 = '2026-01-01T00:00:00.000Z';
  const t1 = '2026-01-01T00:00:01.000Z';
  const t2 = '2026-01-01T00:00:02.000Z';
  const t3 = '2026-01-01T00:00:03.000Z';

  it('filters HTTP logs between STEP_STARTED and STEP_COMPLETED timestamps', () => {
    const execLogs = [
      makeExecLog({ eventType: 'STEP_STARTED', stepIndex: 0, timestamp: t0 }),
      makeExecLog({
        eventType: 'STEP_COMPLETED',
        stepIndex: 0,
        timestamp: t2,
      }),
    ];
    const httpLogs = [
      makeHttpLog({ id: 'before', requestSentAt: '2025-12-31T23:59:59.000Z' }),
      makeHttpLog({ id: 'during', requestSentAt: t1 }),
      makeHttpLog({ id: 'after', requestSentAt: t3 }),
    ];

    const result = filterLogsByTimeWindow(httpLogs, execLogs, 0);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('during');
  });

  it('includes logs at exact boundary timestamps', () => {
    const execLogs = [
      makeExecLog({ eventType: 'STEP_STARTED', stepIndex: 0, timestamp: t0 }),
      makeExecLog({
        eventType: 'STEP_COMPLETED',
        stepIndex: 0,
        timestamp: t2,
      }),
    ];
    const httpLogs = [
      makeHttpLog({ id: 'at-start', requestSentAt: t0 }),
      makeHttpLog({ id: 'at-end', requestSentAt: t2 }),
    ];

    const result = filterLogsByTimeWindow(httpLogs, execLogs, 0);
    expect(result).toHaveLength(2);
  });

  it('returns empty when no STEP_STARTED found', () => {
    const execLogs = [
      makeExecLog({
        eventType: 'STEP_COMPLETED',
        stepIndex: 0,
        timestamp: t2,
      }),
    ];
    const httpLogs = [makeHttpLog({ id: 'h1', requestSentAt: t1 })];

    const result = filterLogsByTimeWindow(httpLogs, execLogs, 0);
    expect(result).toHaveLength(0);
  });

  it('uses Date.now() as end when no STEP_COMPLETED', () => {
    const now = Date.now();
    const execLogs = [
      makeExecLog({ eventType: 'STEP_STARTED', stepIndex: 0, timestamp: t0 }),
    ];
    const httpLogs = [
      makeHttpLog({ id: 'h1', requestSentAt: t1 }),
      makeHttpLog({
        id: 'future',
        requestSentAt: new Date(now + 100000).toISOString(),
      }),
    ];

    const result = filterLogsByTimeWindow(httpLogs, execLogs, 0);
    // h1 is within window (after start, before now); future is beyond now
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('h1');
  });

  it('excludes logs with null requestSentAt', () => {
    const execLogs = [
      makeExecLog({ eventType: 'STEP_STARTED', stepIndex: 0, timestamp: t0 }),
      makeExecLog({
        eventType: 'STEP_COMPLETED',
        stepIndex: 0,
        timestamp: t2,
      }),
    ];
    const httpLogs = [makeHttpLog({ id: 'no-time', requestSentAt: null })];

    const result = filterLogsByTimeWindow(httpLogs, execLogs, 0);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildInstanceMenuItems
// ---------------------------------------------------------------------------

describe('buildInstanceMenuItems', () => {
  const baseInstance: InstanceSummary = {
    id: 'inst-1',
    name: 'my-test',
    status: 'COMPLETED',
  };

  const baseDef: DefinitionSnapshot = {
    name: 'my-test',
    items: [
      { name: 'auth-svc', type: 'SERVICE' },
      { name: 'my-db', type: 'DATABASE' },
    ],
  };

  const instanceItems: InstanceItemStatus[] = [
    {
      id: 'ii-1',
      itemDefinitionName: 'auth-svc',
      status: 'RUNNING',
      readinessStatus: 'READY',
    },
    {
      id: 'ii-2',
      itemDefinitionName: 'my-db',
      status: 'RUNNING',
      readinessStatus: 'READY',
    },
  ];

  const sectionItems: MenuItem<InstanceMenuAction>[] = [
    { label: 'Step 1: login', value: { kind: 'suite', suiteIndex: 0 } },
  ];

  beforeEach(() => {
    Object.defineProperty(process.stdout, 'columns', {
      value: 80,
      configurable: true,
    });
  });

  it('includes error message when instance has errorMessage', () => {
    const inst: InstanceSummary = {
      ...baseInstance,
      errorMessage: 'Something broke',
    };
    const result = buildInstanceMenuItems(
      baseDef,
      inst,
      instanceItems,
      [],
      'Tests',
      false,
    );

    const errorItem = result.find((m) => m.label.includes('Something broke'));
    expect(errorItem).toBeDefined();
    expect(errorItem!.disabled).toBe(true);
  });

  it('includes "Raw Definition" item when definition exists', () => {
    const result = buildInstanceMenuItems(
      baseDef,
      baseInstance,
      instanceItems,
      [],
      'Tests',
      false,
    );

    const rawItem = result.find((m) => m.label === 'Raw Definition');
    expect(rawItem).toBeDefined();
    expect((rawItem!.value as InstanceMenuAction).kind).toBe('raw');
  });

  it('includes "Test Logs" when sectionLabel is Tests', () => {
    const result = buildInstanceMenuItems(
      baseDef,
      baseInstance,
      instanceItems,
      [],
      'Tests',
      false,
    );

    const testLogsItem = result.find((m) => m.label === 'Test Logs');
    expect(testLogsItem).toBeDefined();
    expect((testLogsItem!.value as InstanceMenuAction).kind).toBe('test-logs');
  });

  it('does not include "Test Logs" when sectionLabel is not Tests', () => {
    const result = buildInstanceMenuItems(
      baseDef,
      baseInstance,
      instanceItems,
      [],
      'Traffic',
      false,
    );

    const testLogsItem = result.find((m) => m.label === 'Test Logs');
    expect(testLogsItem).toBeUndefined();
  });

  it('includes "Screenshots" when hasScreenshots is true', () => {
    const result = buildInstanceMenuItems(
      baseDef,
      baseInstance,
      instanceItems,
      [],
      'Tests',
      true,
    );

    const ssItem = result.find((m) => m.label === 'Screenshots');
    expect(ssItem).toBeDefined();
    expect((ssItem!.value as InstanceMenuAction).kind).toBe('screenshots');
  });

  it('does not include "Screenshots" when hasScreenshots is false', () => {
    const result = buildInstanceMenuItems(
      baseDef,
      baseInstance,
      instanceItems,
      [],
      'Tests',
      false,
    );

    const ssItem = result.find((m) => m.label === 'Screenshots');
    expect(ssItem).toBeUndefined();
  });

  it('includes item list with type colors and status suffixes', () => {
    const result = buildInstanceMenuItems(
      baseDef,
      baseInstance,
      instanceItems,
      [],
      'Tests',
      false,
    );

    // Should have an "Items" section header
    const itemsHeader = result.find(
      (m) => m.label.includes('Items') && m.disabled,
    );
    expect(itemsHeader).toBeDefined();

    // Should contain items with type tags
    const serviceItem = result.find((m) => m.label.includes('[service]'));
    expect(serviceItem).toBeDefined();
    expect((serviceItem!.value as InstanceMenuAction).kind).toBe('item');

    const dbItem = result.find((m) => m.label.includes('[database]'));
    expect(dbItem).toBeDefined();
  });

  it('includes section items (test steps)', () => {
    const result = buildInstanceMenuItems(
      baseDef,
      baseInstance,
      instanceItems,
      sectionItems,
      'Tests',
      false,
    );

    const stepItem = result.find((m) => m.label === 'Step 1: login');
    expect(stepItem).toBeDefined();

    // Section header
    const testsHeader = result.find(
      (m) => m.label.includes('Tests') && m.disabled,
    );
    expect(testsHeader).toBeDefined();
  });

  it('handles null definition', () => {
    const result = buildInstanceMenuItems(
      null,
      baseInstance,
      instanceItems,
      sectionItems,
      'Tests',
      false,
    );

    // No Raw Definition
    const rawItem = result.find((m) => m.label === 'Raw Definition');
    expect(rawItem).toBeUndefined();

    // No Items section
    const serviceItem = result.find((m) => m.label.includes('[service]'));
    expect(serviceItem).toBeUndefined();

    // Section items still present
    const stepItem = result.find((m) => m.label === 'Step 1: login');
    expect(stepItem).toBeDefined();
  });
});
