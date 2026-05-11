import type {
  InstanceSummary,
  DefinitionSnapshotItem,
  InstanceItemStatus,
} from '../lib/inspect-types';

jest.mock('../lib/cli-utils', () => ({
  fetchJson: jest.fn(),
}));

jest.mock('../lib/menu', () => ({
  selectMenu: jest.fn(),
}));

jest.mock('../lib/editor', () => ({
  stripIds: jest.fn((x: unknown) => x),
  formatConsoleLogs: jest.fn(() => 'formatted console'),
  formatPodLogs: jest.fn(() => 'formatted pods'),
  openInEditor: jest.fn(),
}));

import { showItemDetailFlow } from './inspect-item-flow';
import { fetchJson } from '../lib/cli-utils';
import { selectMenu } from '../lib/menu';
import { openInEditor } from '../lib/editor';

const mockFetchJson = fetchJson as jest.MockedFunction<typeof fetchJson>;
const mockSelectMenu = selectMenu as jest.MockedFunction<typeof selectMenu>;
const mockOpenInEditor = openInEditor as jest.MockedFunction<
  typeof openInEditor
>;

describe('showItemDetailFlow', () => {
  const ctUrl = 'http://localhost:19001';
  const instance: InstanceSummary = {
    id: 'inst-1',
    name: 'my-def',
    status: 'COMPLETED',
  };
  const item: DefinitionSnapshotItem = {
    name: 'svc-a',
    type: 'SERVICE',
  };
  const instanceItems: InstanceItemStatus[] = [
    {
      id: 'ii-1',
      itemDefinitionName: 'svc-a',
      status: 'RUNNING',
      readinessStatus: 'READY',
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    (process.stdout.write as jest.Mock).mockRestore();
  });

  it('shows menu with Raw Definition option', async () => {
    mockSelectMenu.mockResolvedValueOnce(null);

    await showItemDetailFlow(ctUrl, instance, item, instanceItems);

    expect(mockSelectMenu).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Raw Definition',
          value: { kind: 'raw-item' },
        }),
      ]),
      expect.stringContaining('svc-a'),
      expect.any(Object),
    );
  });

  it('shows Console Logs option when instance item exists', async () => {
    mockSelectMenu.mockResolvedValueOnce(null);

    await showItemDetailFlow(ctUrl, instance, item, instanceItems);

    expect(mockSelectMenu).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Console Logs',
          value: { kind: 'console-logs' },
        }),
      ]),
      expect.any(String),
      expect.any(Object),
    );
  });

  it('hides Console Logs option when instance item not found', async () => {
    mockSelectMenu.mockResolvedValueOnce(null);

    await showItemDetailFlow(ctUrl, instance, item, []);

    const menuItems = (mockSelectMenu as jest.Mock).mock.calls[0][0];
    const labels = menuItems.map((m: { label: string }) => m.label);
    expect(labels).not.toContain('Console Logs');
  });

  it('shows Pod Logs option when instance has error message', async () => {
    const errorInstance: InstanceSummary = {
      ...instance,
      errorMessage: 'step 1 failed',
    };
    mockSelectMenu.mockResolvedValueOnce(null);

    await showItemDetailFlow(ctUrl, errorInstance, item, instanceItems);

    expect(mockSelectMenu).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Pod Logs',
          value: { kind: 'pod-logs' },
        }),
      ]),
      expect.any(String),
      expect.any(Object),
    );
  });

  it('opens raw item definition in editor', async () => {
    mockSelectMenu
      .mockResolvedValueOnce({
        value: { kind: 'raw-item' },
        index: 0,
      })
      .mockResolvedValueOnce(null);

    await showItemDetailFlow(ctUrl, instance, item, instanceItems);

    expect(mockOpenInEditor).toHaveBeenCalledWith(item, 'my-def-svc-a.json');
  });

  it('fetches and displays console logs', async () => {
    mockSelectMenu
      .mockResolvedValueOnce({
        value: { kind: 'console-logs' },
        index: 1,
      })
      .mockResolvedValueOnce(null);

    mockFetchJson.mockResolvedValueOnce({
      logs: [
        {
          id: '1',
          message: 'hello',
          level: 'info',
          timestamp: '2026-01-01T00:00:00Z',
        },
      ],
    });

    await showItemDetailFlow(ctUrl, instance, item, instanceItems);

    expect(mockFetchJson).toHaveBeenCalledWith(
      expect.stringContaining('/logs/console/instance/inst-1'),
    );
    expect(mockFetchJson).toHaveBeenCalledWith(
      expect.stringContaining('instanceItemId=ii-1'),
    );
    expect(mockOpenInEditor).toHaveBeenCalled();
  });

  it('fetches and displays pod logs', async () => {
    const errorInstance: InstanceSummary = {
      ...instance,
      errorMessage: 'step 1 failed',
    };

    mockSelectMenu
      .mockResolvedValueOnce({
        value: { kind: 'pod-logs' },
        index: 2,
      })
      .mockResolvedValueOnce(null);

    mockFetchJson.mockResolvedValueOnce({
      logs: [
        {
          id: '1',
          instanceId: 'inst-1',
          eventType: 'POD_LOGS',
          message: '[item:svc-a] some output',
          stepIndex: null,
          subActionIndex: null,
          subStepIndex: null,
          actionType: null,
          selector: null,
          duration: null,
          error: null,
          errorType: null,
          variables: {},
          timestamp: '2026-01-01T00:00:00Z',
        },
      ],
    });

    await showItemDetailFlow(ctUrl, errorInstance, item, instanceItems);

    expect(mockFetchJson).toHaveBeenCalledWith(
      expect.stringContaining('/logs/test-execution/instance/inst-1'),
    );
    expect(mockOpenInEditor).toHaveBeenCalled();
  });

  it('returns back on escape', async () => {
    mockSelectMenu.mockResolvedValueOnce(null);

    const result = await showItemDetailFlow(
      ctUrl,
      instance,
      item,
      instanceItems,
    );

    expect(result).toBe('back');
  });

  it('loops back after viewing detail', async () => {
    mockSelectMenu
      .mockResolvedValueOnce({
        value: { kind: 'raw-item' },
        index: 0,
      })
      .mockResolvedValueOnce(null);

    const result = await showItemDetailFlow(
      ctUrl,
      instance,
      item,
      instanceItems,
    );

    expect(result).toBe('back');
    expect(mockSelectMenu).toHaveBeenCalledTimes(2);
  });
});
