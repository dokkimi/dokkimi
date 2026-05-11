jest.mock('./cli-utils', () => ({
  fetchJson: jest.fn(),
}));
jest.mock('./menu', () => ({
  selectMenu: jest.fn(),
}));
jest.mock('./terminal', () => ({
  scrollableView: jest.fn(),
  waitForKey: jest.fn(),
}));
jest.mock('./editor', () => ({
  openInEditor: jest.fn(),
  openFile: jest.fn(),
  stripIds: jest.fn((v: unknown) => v),
  formatHttpLog: jest.fn(() => 'formatted-http'),
  formatDbLog: jest.fn(() => 'formatted-db'),
  formatTestExecutionLogs: jest.fn(() => 'formatted-exec-logs'),
  formatConsoleLogs: jest.fn(() => 'formatted-console'),
  formatPodLogs: jest.fn(() => 'formatted-pod-logs'),
}));
jest.mock('./formatting', () => ({
  formatLogLine: jest.fn(() => 'GET /api 200'),
  formatDbLogLine: jest.fn(() => 'SELECT * FROM users'),
  itemTypeColor: jest.fn(() => '\x1b[36m'),
  instanceStatusBadge: jest.fn(() => '[PASSED]'),
}));
jest.mock('./format-ui-timeline', () => ({
  formatUiTimeline: jest.fn(() => ['timeline line 1', 'timeline line 2']),
  formatStepCallTree: jest.fn(() => ['call-tree line 1']),
}));
jest.mock('./inspect-helpers', () => ({
  filterLogsByTimeWindow: jest.fn(() => []),
  getGroupVariables: jest.fn(() => ({ before: {}, after: {} })),
}));

import { showStepDetail } from './inspect-step-detail';
import { fetchJson } from './cli-utils';
import { selectMenu } from './menu';
import {
  openInEditor,
  stripIds,
  formatHttpLog,
  formatDbLog,
  formatConsoleLogs,
  formatTestExecutionLogs,
} from './editor';
import { getGroupVariables } from './inspect-helpers';
import { formatUiTimeline, formatStepCallTree } from './format-ui-timeline';
import type {
  InstanceSummary,
  FlatStepGroup,
  AssertionResult,
  TestExecutionLog,
  HttpLog,
  DefinitionSnapshot,
  InstanceItemStatus,
  ArtifactRow,
} from './inspect-types';

const mockFetchJson = fetchJson as jest.Mock;
const mockSelectMenu = selectMenu as jest.Mock;
const mockOpenInEditor = openInEditor as jest.Mock;
const mockStripIds = stripIds as jest.Mock;
const mockFormatHttpLog = formatHttpLog as jest.Mock;
const mockFormatDbLog = formatDbLog as jest.Mock;
const mockFormatConsoleLogs = formatConsoleLogs as jest.Mock;
const mockFormatTestExecLogs = formatTestExecutionLogs as jest.Mock;
const mockGetGroupVariables = getGroupVariables as jest.Mock;
const mockFormatUiTimeline = formatUiTimeline as jest.Mock;
const mockFormatStepCallTree = formatStepCallTree as jest.Mock;

// Suppress stdout writes (clear screen sequences)
jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

const instance: InstanceSummary = {
  id: 'inst-1',
  name: 'my-test',
  status: 'COMPLETED',
  testStatus: 'PASSED',
};

const step = {
  name: 'call auth',
  action: { type: 'httpCall', method: 'GET', url: '/api/auth' },
};

const flatGroups: FlatStepGroup[] = [
  { globalIndex: 0, testName: 'Suite A', steps: [step] },
];

const execLogs: TestExecutionLog[] = [
  {
    id: 'log-1',
    instanceId: 'inst-1',
    eventType: 'STEP_STARTED',
    message: 'Starting step',
    stepIndex: 0,
    subActionIndex: null,
    subStepIndex: null,
    actionType: 'httpCall',
    selector: null,
    duration: null,
    error: null,
    errorType: null,
    variables: {},
    timestamp: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'log-2',
    instanceId: 'inst-1',
    eventType: 'STEP_COMPLETED',
    message: 'Step completed',
    stepIndex: 0,
    subActionIndex: null,
    subStepIndex: null,
    actionType: 'httpCall',
    selector: null,
    duration: 100,
    error: null,
    errorType: null,
    variables: { token: 'abc' },
    timestamp: '2026-01-01T00:00:00.100Z',
  },
];

const assertionResults: AssertionResult[] = [];
const allHttpLogs: HttpLog[] = [];
const definition: DefinitionSnapshot | null = null;
const instanceItems: InstanceItemStatus[] = [];
const screenshots: ArtifactRow[] = [];
const storageDir = '/tmp/storage';

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchJson.mockResolvedValue(null);
});

describe('showStepDetail', () => {
  it('shows step detail menu with available actions', async () => {
    // First call returns a selection, second returns null (back)
    mockSelectMenu
      .mockResolvedValueOnce({ value: { kind: 'raw-step' }, index: 0 })
      .mockResolvedValueOnce(null);

    const result = await showStepDetail(
      'http://ct:19001',
      instance,
      flatGroups,
      0,
      0,
      'Step 1',
      assertionResults,
      execLogs,
      allHttpLogs,
      definition,
      instanceItems,
      screenshots,
      storageDir,
    );

    expect(result).toBe('back');
    expect(mockSelectMenu).toHaveBeenCalled();
    const menuCall = mockSelectMenu.mock.calls[0];
    expect(menuCall[1]).toContain('my-test');
    expect(menuCall[1]).toContain('Step 1');
  });

  it('opens raw step JSON in editor', async () => {
    mockStripIds.mockReturnValue({ name: 'call auth' });
    mockSelectMenu
      .mockResolvedValueOnce({ value: { kind: 'raw-step' }, index: 0 })
      .mockResolvedValueOnce(null);

    await showStepDetail(
      'http://ct:19001',
      instance,
      flatGroups,
      0,
      0,
      'Step 1',
      assertionResults,
      execLogs,
      allHttpLogs,
      definition,
      instanceItems,
      screenshots,
      storageDir,
    );

    expect(mockStripIds).toHaveBeenCalledWith(step);
    expect(mockOpenInEditor).toHaveBeenCalledWith(
      { name: 'call auth' },
      expect.stringContaining('-raw.json'),
    );
  });

  it('opens test logs in editor', async () => {
    mockSelectMenu
      .mockResolvedValueOnce({ value: { kind: 'test-logs' }, index: 1 })
      .mockResolvedValueOnce(null);

    await showStepDetail(
      'http://ct:19001',
      instance,
      flatGroups,
      0,
      0,
      'Step 1',
      assertionResults,
      execLogs,
      allHttpLogs,
      definition,
      instanceItems,
      screenshots,
      storageDir,
    );

    expect(mockFormatTestExecLogs).toHaveBeenCalledWith(execLogs);
    expect(mockOpenInEditor).toHaveBeenCalledWith(
      'formatted-exec-logs',
      expect.stringContaining('-test-logs.log'),
    );
  });

  it('shows assertions in editor', async () => {
    const stepAssertions: AssertionResult[] = [
      {
        id: 'a-1',
        instanceId: 'inst-1',
        stepIndex: 0,
        assertionIndex: 0,
        assertionType: 'self',
        passed: true,
        expected: 200,
        actual: 200,
        error: null,
        path: 'response.statusCode',
        operator: 'equals',
        blockIndex: 0,
        resultKind: null,
      },
    ];

    const stepWithAssertions = {
      ...step,
      assertions: [{ match: { method: 'GET', url: '/api/auth' } }],
    };
    const groups: FlatStepGroup[] = [
      { globalIndex: 0, testName: 'Suite A', steps: [stepWithAssertions] },
    ];

    mockSelectMenu
      .mockResolvedValueOnce({ value: { kind: 'assertions' }, index: 2 })
      .mockResolvedValueOnce(null);

    await showStepDetail(
      'http://ct:19001',
      instance,
      groups,
      0,
      0,
      'Step 1',
      stepAssertions,
      execLogs,
      allHttpLogs,
      definition,
      instanceItems,
      screenshots,
      storageDir,
    );

    expect(mockOpenInEditor).toHaveBeenCalledWith(
      expect.stringContaining('Assertions'),
      expect.stringContaining('-assertions.log'),
    );
  });

  it('shows variables (before/after)', async () => {
    mockGetGroupVariables.mockReturnValue({
      before: { userId: '123' },
      after: { userId: '123', token: 'abc' },
    });

    // First call: variables-before, second: variables-after, third: back
    mockSelectMenu
      .mockResolvedValueOnce({ value: { kind: 'variables-before' }, index: 0 })
      .mockResolvedValueOnce({ value: { kind: 'variables-after' }, index: 1 })
      .mockResolvedValueOnce(null);

    await showStepDetail(
      'http://ct:19001',
      instance,
      flatGroups,
      0,
      0,
      'Step 1',
      assertionResults,
      execLogs,
      allHttpLogs,
      definition,
      instanceItems,
      screenshots,
      storageDir,
    );

    expect(mockOpenInEditor).toHaveBeenCalledWith(
      { userId: '123' },
      expect.stringContaining('-variables-before.json'),
    );
    expect(mockOpenInEditor).toHaveBeenCalledWith(
      { userId: '123', token: 'abc' },
      expect.stringContaining('-variables-after.json'),
    );
  });

  it('opens HTTP log detail', async () => {
    const httpLog: HttpLog = {
      id: 'http-1',
      method: 'GET',
      url: '/api/users',
      statusCode: 200,
      origin: 'svc-a',
      target: 'svc-b',
      requestBody: null,
      responseBody: { users: [] },
      requestHeaders: null,
      responseHeaders: null,
      isMocked: false,
      requestSentAt: '2026-01-01T00:00:00.000Z',
      responseReceivedAt: '2026-01-01T00:00:00.050Z',
      duration: 50,
    };

    mockSelectMenu
      .mockResolvedValueOnce({
        value: { kind: 'http-log', log: httpLog, index: 1 },
        index: 0,
      })
      .mockResolvedValueOnce(null);

    await showStepDetail(
      'http://ct:19001',
      instance,
      flatGroups,
      0,
      0,
      'Step 1',
      assertionResults,
      execLogs,
      allHttpLogs,
      definition,
      instanceItems,
      screenshots,
      storageDir,
    );

    expect(mockFormatHttpLog).toHaveBeenCalledWith(httpLog);
    expect(mockOpenInEditor).toHaveBeenCalledWith(
      'formatted-http',
      expect.stringContaining('-http-log-1.json'),
    );
  });

  it('opens DB log detail', async () => {
    const dbLog = {
      id: 'db-1',
      instanceId: 'inst-1',
      instanceItemId: null,
      databaseType: 'postgres',
      databaseName: 'mydb',
      query: 'SELECT 1',
      params: null,
      success: true,
      data: null,
      rowsAffected: null,
      error: null,
      duration: 5,
      timestamp: '2026-01-01T00:00:00.000Z',
    };

    mockSelectMenu
      .mockResolvedValueOnce({
        value: { kind: 'db-log', log: dbLog, index: 1 },
        index: 0,
      })
      .mockResolvedValueOnce(null);

    await showStepDetail(
      'http://ct:19001',
      instance,
      flatGroups,
      0,
      0,
      'Step 1',
      assertionResults,
      execLogs,
      allHttpLogs,
      definition,
      instanceItems,
      screenshots,
      storageDir,
    );

    expect(mockFormatDbLog).toHaveBeenCalledWith(dbLog);
    expect(mockOpenInEditor).toHaveBeenCalledWith(
      'formatted-db',
      expect.stringContaining('-db-query-1.json'),
    );
  });

  it('shows console logs in editor', async () => {
    const defWithItems: DefinitionSnapshot = {
      name: 'my-test',
      items: [{ name: 'auth-svc', type: 'SERVICE' }],
    };
    const items: InstanceItemStatus[] = [
      {
        id: 'ii-1',
        itemDefinitionName: 'auth-svc',
        status: 'RUNNING',
        readinessStatus: 'READY',
      },
    ];

    mockFetchJson.mockResolvedValue({
      logs: [
        {
          id: 'cl-1',
          message: 'hello',
          timestamp: '2026-01-01T00:00:00.000Z',
          level: 'info',
          instanceId: 'inst-1',
          instanceItemId: 'ii-1',
        },
      ],
      total: 1,
    });

    mockSelectMenu
      .mockResolvedValueOnce({
        value: {
          kind: 'console-log',
          itemName: 'auth-svc',
          instanceItemId: 'ii-1',
        },
        index: 0,
      })
      .mockResolvedValueOnce(null);

    await showStepDetail(
      'http://ct:19001',
      instance,
      flatGroups,
      0,
      0,
      'Step 1',
      assertionResults,
      execLogs,
      allHttpLogs,
      defWithItems,
      items,
      screenshots,
      storageDir,
    );

    expect(mockFetchJson).toHaveBeenCalledWith(
      expect.stringContaining('/logs/console/instance/inst-1'),
    );
    expect(mockFormatConsoleLogs).toHaveBeenCalled();
    expect(mockOpenInEditor).toHaveBeenCalledWith(
      'formatted-console',
      expect.stringContaining('-auth-svc-console.log'),
    );
  });

  it('shows UI timeline in editor', async () => {
    const uiStep = { name: 'click login', action: { type: 'ui' } };
    const uiGroups: FlatStepGroup[] = [
      { globalIndex: 0, testName: 'Suite A', steps: [uiStep] },
    ];

    mockFetchJson.mockResolvedValue([
      { stepIndex: 0, action: 'click', message: 'click button', children: [] },
    ]);

    mockSelectMenu
      .mockResolvedValueOnce({ value: { kind: 'ui-timeline' }, index: 0 })
      .mockResolvedValueOnce(null);

    await showStepDetail(
      'http://ct:19001',
      instance,
      uiGroups,
      0,
      0,
      'Step 1',
      assertionResults,
      execLogs,
      allHttpLogs,
      definition,
      instanceItems,
      screenshots,
      storageDir,
    );

    expect(mockFetchJson).toHaveBeenCalledWith(
      'http://ct:19001/logs/ui-timeline/instance/inst-1',
    );
    expect(mockFormatUiTimeline).toHaveBeenCalled();
    expect(mockOpenInEditor).toHaveBeenCalledWith(
      expect.stringContaining('timeline'),
      expect.stringContaining('-timeline.log'),
    );
  });

  it('shows call tree in editor for non-UI steps', async () => {
    mockFetchJson.mockResolvedValue([]);

    mockSelectMenu
      .mockResolvedValueOnce({ value: { kind: 'call-tree' }, index: 0 })
      .mockResolvedValueOnce(null);

    await showStepDetail(
      'http://ct:19001',
      instance,
      flatGroups,
      0,
      0,
      'Step 1',
      assertionResults,
      execLogs,
      allHttpLogs,
      definition,
      instanceItems,
      screenshots,
      storageDir,
    );

    expect(mockFetchJson).toHaveBeenCalledWith(
      'http://ct:19001/logs/call-tree/instance/inst-1/step/0',
    );
    expect(mockFormatStepCallTree).toHaveBeenCalled();
    expect(mockOpenInEditor).toHaveBeenCalledWith(
      expect.stringContaining('call-tree'),
      expect.stringContaining('-timeline.log'),
    );
  });

  it('back navigation returns "back"', async () => {
    mockSelectMenu.mockResolvedValueOnce(null);

    const result = await showStepDetail(
      'http://ct:19001',
      instance,
      flatGroups,
      0,
      0,
      'Step 1',
      assertionResults,
      execLogs,
      allHttpLogs,
      definition,
      instanceItems,
      screenshots,
      storageDir,
    );

    expect(result).toBe('back');
  });

  it('handles steps without assertions - no assertion menu item', async () => {
    // selectMenu returns null immediately (back)
    mockSelectMenu.mockResolvedValueOnce(null);

    await showStepDetail(
      'http://ct:19001',
      instance,
      flatGroups,
      0,
      0,
      'Step 1',
      [], // no assertions
      execLogs,
      allHttpLogs,
      definition,
      instanceItems,
      screenshots,
      storageDir,
    );

    // Verify the menu items passed to selectMenu do not include assertions
    const menuItems = mockSelectMenu.mock.calls[0][0];
    const assertionItem = menuItems.find(
      (item: { value: { kind?: string } }) => item.value?.kind === 'assertions',
    );
    expect(assertionItem).toBeUndefined();
  });

  it('shows screenshots action when artifacts present', async () => {
    const testScreenshots: ArtifactRow[] = [
      {
        id: 'art-1',
        instanceId: 'inst-1',
        stepIndex: 0,
        subStepIndex: 0,
        type: 'screenshot',
        name: 'login-page.png',
        uri: 'artifacts/login-page.png',
        verdict: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    mockSelectMenu.mockResolvedValueOnce(null);

    await showStepDetail(
      'http://ct:19001',
      instance,
      flatGroups,
      0,
      0,
      'Step 1',
      assertionResults,
      execLogs,
      allHttpLogs,
      definition,
      instanceItems,
      testScreenshots,
      storageDir,
    );

    const menuItems = mockSelectMenu.mock.calls[0][0];
    const ssItem = menuItems.find(
      (item: { value: { kind?: string } }) =>
        item.value?.kind === 'screenshots',
    );
    expect(ssItem).toBeDefined();
    expect(ssItem.label).toContain('Screenshots');
    expect(ssItem.label).toContain('1');
  });

  it('opens screenshots with correct file paths', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { openFile } = require('./editor');
    const mockOpenFile = openFile as jest.Mock;

    const testScreenshots: ArtifactRow[] = [
      {
        id: 'art-1',
        instanceId: 'inst-1',
        stepIndex: 0,
        subStepIndex: 0,
        type: 'screenshot',
        name: 'login-page.png',
        uri: 'artifacts/login-page.png',
        verdict: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    // First: pick screenshots, then pick a screenshot, then back from screenshots, then back from main
    mockSelectMenu
      .mockResolvedValueOnce({ value: { kind: 'screenshots' }, index: 0 })
      .mockResolvedValueOnce({ value: testScreenshots[0], index: 0 })
      .mockResolvedValueOnce(null) // back from screenshots
      .mockResolvedValueOnce(null); // back from main

    await showStepDetail(
      'http://ct:19001',
      instance,
      flatGroups,
      0,
      0,
      'Step 1',
      assertionResults,
      execLogs,
      allHttpLogs,
      definition,
      instanceItems,
      testScreenshots,
      storageDir,
    );

    expect(mockOpenFile).toHaveBeenCalledWith(
      expect.stringContaining('artifacts/login-page.png'),
    );
  });

  it('displays error message for instance with error', async () => {
    const errorInstance: InstanceSummary = {
      ...instance,
      errorMessage: 'step group 1 failed: timeout',
    };

    mockSelectMenu.mockResolvedValueOnce(null);

    await showStepDetail(
      'http://ct:19001',
      errorInstance,
      flatGroups,
      0,
      0,
      'Step 1',
      assertionResults,
      execLogs,
      allHttpLogs,
      definition,
      instanceItems,
      screenshots,
      storageDir,
    );

    const menuItems = mockSelectMenu.mock.calls[0][0];
    const errorItem = menuItems.find((item: { label: string }) =>
      item.label.includes('timeout'),
    );
    expect(errorItem).toBeDefined();
    expect(errorItem.disabled).toBe(true);
  });
});
