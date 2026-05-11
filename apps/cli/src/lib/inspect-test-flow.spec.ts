import type {
  InstanceSummary,
  DefinitionSnapshot,
  InstanceItemStatus,
  TestSuite,
} from '../lib/inspect-types';

jest.mock('../lib/cli-utils', () => ({
  fetchJson: jest.fn(),
}));

jest.mock('../lib/menu', () => ({
  selectMenu: jest.fn(),
}));

jest.mock('../lib/inspect-step-detail', () => ({
  showStepDetail: jest.fn(),
}));

jest.mock('../lib/inspect-item-flow', () => ({
  showItemDetailFlow: jest.fn(),
}));

jest.mock('../lib/editor', () => ({
  stripIds: jest.fn((x: unknown) => x),
  openInEditor: jest.fn(),
  openFile: jest.fn(),
  formatTestExecutionLogs: jest.fn(() => 'formatted logs'),
}));

jest.mock('../lib/formatting', () => ({
  fitText: jest.fn((t: string) => t),
  statusBadge: jest.fn((s: string) => s),
  instanceStatusBadge: jest.fn((i: InstanceSummary) => i.status),
  describeAction: jest.fn(() => '(action)'),
}));

jest.mock('../lib/inspect-helpers', () => ({
  buildInstanceMenuItems: jest.fn(
    (
      _def: unknown,
      _inst: unknown,
      _items: unknown,
      sectionItems: unknown[],
    ) => [{ label: 'Raw Definition', value: { kind: 'raw' } }, ...sectionItems],
  ),
  deriveGroupStatuses: jest.fn(() => new Map()),
  deriveStepAssertionStatuses: jest.fn(() => new Map()),
  rewriteErrorMessage: jest.fn((msg: string) => msg),
}));

import { showTestStepsFlow } from './inspect-test-flow';
import { fetchJson } from '../lib/cli-utils';
import { selectMenu } from '../lib/menu';
import { showStepDetail } from '../lib/inspect-step-detail';
import { showItemDetailFlow } from '../lib/inspect-item-flow';

const mockFetchJson = fetchJson as jest.MockedFunction<typeof fetchJson>;
const mockSelectMenu = selectMenu as jest.MockedFunction<typeof selectMenu>;
const mockShowStepDetail = showStepDetail as jest.MockedFunction<
  typeof showStepDetail
>;
const mockShowItemDetailFlow = showItemDetailFlow as jest.MockedFunction<
  typeof showItemDetailFlow
>;

describe('showTestStepsFlow', () => {
  const ctUrl = 'http://localhost:19001';
  const storageDir = '/tmp/dokkimi';
  const instance: InstanceSummary = {
    id: 'inst-1',
    name: 'my-def',
    status: 'COMPLETED',
  };
  const definition: DefinitionSnapshot = {
    name: 'my-def',
    items: [{ name: 'svc-a', type: 'SERVICE' }],
    tests: [
      {
        name: 'Login Flow',
        steps: [{ name: 'send request' }, { name: 'check response' }],
      },
    ],
  };
  const instanceItems: InstanceItemStatus[] = [];
  const tests: TestSuite[] = definition.tests!;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    Object.defineProperty(process.stdout, 'columns', {
      value: 120,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    (process.stdout.write as jest.Mock).mockRestore();
  });

  it('fetches execution logs, assertions, http logs, and artifacts', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ logs: [] })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ logs: [] })
      .mockResolvedValueOnce({ artifacts: [] });

    mockSelectMenu.mockResolvedValueOnce(null);

    await showTestStepsFlow(
      ctUrl,
      instance,
      definition,
      instanceItems,
      tests,
      storageDir,
    );

    expect(mockFetchJson).toHaveBeenCalledWith(
      `${ctUrl}/logs/test-execution/instance/inst-1`,
    );
    expect(mockFetchJson).toHaveBeenCalledWith(
      `${ctUrl}/logs/assertion-results/instance/inst-1`,
    );
    expect(mockFetchJson).toHaveBeenCalledWith(
      `${ctUrl}/logs/http/instance/inst-1?limit=500`,
    );
    expect(mockFetchJson).toHaveBeenCalledWith(
      `${ctUrl}/artifacts/instance/inst-1`,
    );
  });

  it('shows test suites menu and returns back on escape', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ logs: [] })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ logs: [] })
      .mockResolvedValueOnce({ artifacts: [] });

    mockSelectMenu.mockResolvedValueOnce(null);

    const result = await showTestStepsFlow(
      ctUrl,
      instance,
      definition,
      instanceItems,
      tests,
      storageDir,
    );

    expect(result).toBe('back');
    expect(mockSelectMenu).toHaveBeenCalledTimes(1);
  });

  it('drills into suite and step detail', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ logs: [] })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ logs: [] })
      .mockResolvedValueOnce({ artifacts: [] });

    // First: user picks a suite
    mockSelectMenu.mockResolvedValueOnce({
      value: { kind: 'suite', suiteIndex: 0 },
      index: 1,
    });

    // Inside substeps flow: user picks a step
    mockSelectMenu.mockResolvedValueOnce({
      value: { stepIndex: 0, subStepIndex: 0, stepLabel: 'Step 1.1' },
      index: 0,
    });

    // showStepDetail returns exit to break out
    mockShowStepDetail.mockResolvedValueOnce('exit');

    const result = await showTestStepsFlow(
      ctUrl,
      instance,
      definition,
      instanceItems,
      tests,
      storageDir,
    );

    expect(result).toBe('exit');
    expect(mockShowStepDetail).toHaveBeenCalled();
  });

  it('navigates to item detail when item is selected', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ logs: [] })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ logs: [] })
      .mockResolvedValueOnce({ artifacts: [] });

    const item = { name: 'svc-a', type: 'SERVICE' as const };

    mockSelectMenu.mockResolvedValueOnce({
      value: { kind: 'item', item },
      index: 0,
    });

    mockShowItemDetailFlow.mockResolvedValueOnce('exit');

    const result = await showTestStepsFlow(
      ctUrl,
      instance,
      definition,
      instanceItems,
      tests,
      storageDir,
    );

    expect(result).toBe('exit');
    expect(mockShowItemDetailFlow).toHaveBeenCalledWith(
      ctUrl,
      instance,
      item,
      instanceItems,
    );
  });

  it('handles no tests gracefully by returning immediately', async () => {
    const emptyTests: TestSuite[] = [];

    mockFetchJson
      .mockResolvedValueOnce({ logs: [] })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ logs: [] })
      .mockResolvedValueOnce({ artifacts: [] });

    mockSelectMenu.mockResolvedValueOnce(null);

    const result = await showTestStepsFlow(
      ctUrl,
      instance,
      definition,
      instanceItems,
      emptyTests,
      storageDir,
    );

    expect(result).toBe('back');
  });

  it('back navigation from substeps flow returns to main menu', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ logs: [] })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ logs: [] })
      .mockResolvedValueOnce({ artifacts: [] });

    // Pick suite
    mockSelectMenu.mockResolvedValueOnce({
      value: { kind: 'suite', suiteIndex: 0 },
      index: 1,
    });

    // Inside substeps: escape (back)
    mockSelectMenu.mockResolvedValueOnce(null);

    // Back at main menu: escape again
    mockSelectMenu.mockResolvedValueOnce(null);

    const result = await showTestStepsFlow(
      ctUrl,
      instance,
      definition,
      instanceItems,
      tests,
      storageDir,
    );

    expect(result).toBe('back');
    // selectMenu called 3 times: main, substeps (escape), main again (escape)
    expect(mockSelectMenu).toHaveBeenCalledTimes(3);
  });

  it('shows step groups with assertion statuses', async () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const {
      deriveGroupStatuses,
      deriveStepAssertionStatuses,
    } = require('../lib/inspect-helpers');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const mockDeriveGroupStatuses = deriveGroupStatuses as jest.Mock;
    const mockDeriveStepAssertionStatuses =
      deriveStepAssertionStatuses as jest.Mock;

    // Set up statuses for our two steps
    const groupStatusMap = new Map<number, string>();
    groupStatusMap.set(0, 'PASSED');
    groupStatusMap.set(1, 'FAILED');
    mockDeriveGroupStatuses.mockReturnValue(groupStatusMap);

    const assertionStatusMap = new Map<string, string>();
    assertionStatusMap.set('0', 'PASSED');
    assertionStatusMap.set('1', 'FAILED');
    mockDeriveStepAssertionStatuses.mockReturnValue(assertionStatusMap);

    mockFetchJson
      .mockResolvedValueOnce({ logs: [] })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ logs: [] })
      .mockResolvedValueOnce({ artifacts: [] });

    mockSelectMenu.mockResolvedValueOnce(null);

    await showTestStepsFlow(
      ctUrl,
      instance,
      definition,
      instanceItems,
      tests,
      storageDir,
    );

    expect(mockDeriveGroupStatuses).toHaveBeenCalled();
    expect(mockDeriveStepAssertionStatuses).toHaveBeenCalled();
    // Menu should have been presented
    expect(mockSelectMenu).toHaveBeenCalledTimes(1);
  });

  it('shows error message for failed instance', async () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const {
      rewriteErrorMessage,
      buildInstanceMenuItems,
    } = require('../lib/inspect-helpers');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const mockRewriteErrorMessage = rewriteErrorMessage as jest.Mock;
    const mockBuildInstanceMenuItems = buildInstanceMenuItems as jest.Mock;

    const failedInstance: InstanceSummary = {
      ...instance,
      status: 'FAILED',
      errorMessage: 'step group 1 failed: assertion mismatch',
    };

    mockRewriteErrorMessage.mockReturnValue(
      '"Login Flow" failed at "send request"',
    );

    mockFetchJson
      .mockResolvedValueOnce({ logs: [] })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ logs: [] })
      .mockResolvedValueOnce({ artifacts: [] });

    mockSelectMenu.mockResolvedValueOnce(null);

    await showTestStepsFlow(
      ctUrl,
      failedInstance,
      definition,
      instanceItems,
      tests,
      storageDir,
    );

    expect(mockRewriteErrorMessage).toHaveBeenCalledWith(
      'step group 1 failed: assertion mismatch',
      expect.any(Array),
    );
    // buildInstanceMenuItems is called with the rewritten error message
    expect(mockBuildInstanceMenuItems).toHaveBeenCalledWith(
      definition,
      expect.objectContaining({
        errorMessage: '"Login Flow" failed at "send request"',
      }),
      instanceItems,
      expect.any(Array),
      'Tests',
      false,
    );
  });

  it('navigates to item flow on item selection', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ logs: [] })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ logs: [] })
      .mockResolvedValueOnce({ artifacts: [] });

    const item = { name: 'svc-a', type: 'SERVICE' as const };

    mockSelectMenu.mockResolvedValueOnce({
      value: { kind: 'item', item },
      index: 0,
    });

    mockShowItemDetailFlow.mockResolvedValueOnce('back');

    // After returning from item flow, user presses back on main menu
    mockSelectMenu.mockResolvedValueOnce(null);

    const result = await showTestStepsFlow(
      ctUrl,
      instance,
      definition,
      instanceItems,
      tests,
      storageDir,
    );

    expect(result).toBe('back');
    expect(mockShowItemDetailFlow).toHaveBeenCalledWith(
      ctUrl,
      instance,
      item,
      instanceItems,
    );
  });
});
