import type {
  InstanceSummary,
  DefinitionSnapshot,
  InstanceItemStatus,
  HttpLog,
} from '../lib/inspect-types';

jest.mock('../lib/cli-utils', () => ({
  fetchJson: jest.fn(),
}));

jest.mock('../lib/menu', () => ({
  selectMenu: jest.fn(),
}));

jest.mock('../lib/terminal', () => ({
  waitForKey: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/editor', () => ({
  stripIds: jest.fn((x: unknown) => x),
  formatHttpLog: jest.fn(() => 'formatted'),
  openInEditor: jest.fn(),
}));

jest.mock('../lib/formatting', () => ({
  formatLogLine: jest.fn(() => 'GET /api → 200'),
  instanceStatusBadge: jest.fn((i: InstanceSummary) => i.status),
}));

jest.mock('../lib/inspect-helpers', () => ({
  buildInstanceMenuItems: jest.fn(
    (
      _def: unknown,
      _inst: unknown,
      _items: unknown,
      sectionItems: unknown[],
    ) => [...sectionItems],
  ),
}));

jest.mock('../lib/inspect-item-flow', () => ({
  showItemDetailFlow: jest.fn(),
}));

import { showHttpLogsFlow } from './inspect-http-flow';
import { fetchJson } from '../lib/cli-utils';
import { selectMenu } from '../lib/menu';
import { waitForKey } from '../lib/terminal';
import { showItemDetailFlow } from '../lib/inspect-item-flow';
import { openInEditor } from '../lib/editor';

const mockFetchJson = fetchJson as jest.MockedFunction<typeof fetchJson>;
const mockSelectMenu = selectMenu as jest.MockedFunction<typeof selectMenu>;
const mockShowItemDetailFlow = showItemDetailFlow as jest.MockedFunction<
  typeof showItemDetailFlow
>;

describe('showHttpLogsFlow', () => {
  const ctUrl = 'http://localhost:19001';
  const instance: InstanceSummary = {
    id: 'inst-1',
    name: 'my-def',
    status: 'COMPLETED',
  };
  const definition: DefinitionSnapshot = { name: 'my-def' };
  const instanceItems: InstanceItemStatus[] = [];

  const sampleLog: HttpLog = {
    id: 'log-1',
    method: 'GET',
    url: '/api/users',
    statusCode: 200,
    origin: 'frontend',
    target: 'backend',
    requestBody: null,
    responseBody: null,
    requestHeaders: null,
    responseHeaders: null,
    isMocked: false,
    requestSentAt: '2026-01-01T00:00:00Z',
    responseReceivedAt: '2026-01-01T00:00:01Z',
    duration: 150,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    (process.stdout.write as jest.Mock).mockRestore();
    (console.log as jest.Mock).mockRestore();
  });

  it('fetches HTTP logs for the instance', async () => {
    mockFetchJson.mockResolvedValueOnce({ logs: [sampleLog] });
    mockSelectMenu.mockResolvedValueOnce(null);

    await showHttpLogsFlow(ctUrl, instance, definition, instanceItems);

    expect(mockFetchJson).toHaveBeenCalledWith(
      `${ctUrl}/logs/http/instance/inst-1?limit=500`,
    );
  });

  it('handles empty logs with message and returns back', async () => {
    mockFetchJson.mockResolvedValueOnce({ logs: [] });

    const result = await showHttpLogsFlow(
      ctUrl,
      instance,
      definition,
      instanceItems,
    );

    expect(result).toBe('back');
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('No traffic logs'),
    );
    expect(waitForKey).toHaveBeenCalled();
  });

  it('handles null response and returns back', async () => {
    mockFetchJson.mockResolvedValueOnce(null);

    const result = await showHttpLogsFlow(
      ctUrl,
      instance,
      definition,
      instanceItems,
    );

    expect(result).toBe('back');
  });

  it('shows log list menu and returns back on escape', async () => {
    mockFetchJson.mockResolvedValueOnce({ logs: [sampleLog] });
    mockSelectMenu.mockResolvedValueOnce(null);

    const result = await showHttpLogsFlow(
      ctUrl,
      instance,
      definition,
      instanceItems,
    );

    expect(result).toBe('back');
    expect(mockSelectMenu).toHaveBeenCalledTimes(1);
  });

  it('opens log detail when traffic-log is selected', async () => {
    mockFetchJson.mockResolvedValueOnce({ logs: [sampleLog] });

    mockSelectMenu
      .mockResolvedValueOnce({
        value: { kind: 'traffic-log', log: sampleLog },
        index: 0,
      })
      .mockResolvedValueOnce(null); // escape after viewing

    await showHttpLogsFlow(ctUrl, instance, definition, instanceItems);

    expect(openInEditor).toHaveBeenCalled();
  });

  it('navigates to item detail flow when item is selected', async () => {
    const item = { name: 'svc-a', type: 'SERVICE' as const };
    mockFetchJson.mockResolvedValueOnce({ logs: [sampleLog] });

    mockSelectMenu.mockResolvedValueOnce({
      value: { kind: 'item', item },
      index: 0,
    });

    mockShowItemDetailFlow.mockResolvedValueOnce('exit');

    const result = await showHttpLogsFlow(
      ctUrl,
      instance,
      definition,
      instanceItems,
    );

    expect(result).toBe('exit');
    expect(mockShowItemDetailFlow).toHaveBeenCalledWith(
      ctUrl,
      instance,
      item,
      instanceItems,
    );
  });

  it('opens raw definition in editor when raw is selected', async () => {
    mockFetchJson.mockResolvedValueOnce({ logs: [sampleLog] });

    mockSelectMenu
      .mockResolvedValueOnce({
        value: { kind: 'raw' },
        index: 0,
      })
      .mockResolvedValueOnce(null);

    await showHttpLogsFlow(ctUrl, instance, definition, instanceItems);

    expect(openInEditor).toHaveBeenCalled();
  });
});
