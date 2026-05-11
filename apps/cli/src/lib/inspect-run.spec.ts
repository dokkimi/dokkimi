import type { InstanceSummary } from './inspect-types';

jest.mock('./cli-utils', () => ({
  fetchJson: jest.fn(),
}));

jest.mock('./menu', () => ({
  selectMenu: jest.fn(),
}));

jest.mock('./inspect-test-flow', () => ({
  showTestStepsFlow: jest.fn(),
}));

jest.mock('./inspect-http-flow', () => ({
  showHttpLogsFlow: jest.fn(),
}));

jest.mock('./terminal', () => ({
  enterAltScreen: jest.fn(),
  exitAltScreen: jest.fn(),
}));

jest.mock('./formatting', () => ({
  formatInstanceLabel: jest.fn((i: InstanceSummary) => i.name),
}));

import { inspectRun } from './inspect-run';
import { fetchJson } from './cli-utils';
import { selectMenu } from './menu';
import { showTestStepsFlow } from './inspect-test-flow';
import { showHttpLogsFlow } from './inspect-http-flow';
import { enterAltScreen, exitAltScreen } from './terminal';

const mockFetchJson = fetchJson as jest.MockedFunction<typeof fetchJson>;
const mockSelectMenu = selectMenu as jest.MockedFunction<typeof selectMenu>;
const mockShowTestStepsFlow = showTestStepsFlow as jest.MockedFunction<
  typeof showTestStepsFlow
>;
const mockShowHttpLogsFlow = showHttpLogsFlow as jest.MockedFunction<
  typeof showHttpLogsFlow
>;

describe('inspectRun', () => {
  const ctUrl = 'http://localhost:19001';
  const runId = 'run-1';
  const storageDir = '/tmp/dokkimi';
  const instances: InstanceSummary[] = [
    { id: 'inst-1', name: 'my-def', status: 'COMPLETED' },
    { id: 'inst-2', name: 'other-def', status: 'FAILED' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    (process.stdout.write as jest.Mock).mockRestore();
  });

  it('enters and exits alt screen', async () => {
    mockSelectMenu.mockResolvedValueOnce(null);

    await inspectRun(ctUrl, runId, instances, storageDir);

    expect(enterAltScreen).toHaveBeenCalled();
    expect(exitAltScreen).toHaveBeenCalled();
  });

  it('shows instance picker menu', async () => {
    mockSelectMenu.mockResolvedValueOnce(null);

    await inspectRun(ctUrl, runId, instances, storageDir);

    expect(mockSelectMenu).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ label: 'my-def' }),
        expect.objectContaining({ label: 'other-def' }),
      ]),
      'Select a definition to inspect:',
    );
  });

  it('navigates to test steps flow when tests exist', async () => {
    const definition = {
      name: 'my-def',
      tests: [{ name: 'suite-1', steps: [{ name: 'step-1' }] }],
    };
    const instanceDetail = { id: 'inst-1', items: [] };

    mockSelectMenu.mockResolvedValueOnce({
      value: instances[0],
      index: 0,
    });
    mockFetchJson
      .mockResolvedValueOnce(definition)
      .mockResolvedValueOnce(instanceDetail);
    mockShowTestStepsFlow.mockResolvedValueOnce('exit');

    await inspectRun(ctUrl, runId, instances, storageDir);

    expect(mockShowTestStepsFlow).toHaveBeenCalledWith(
      ctUrl,
      instances[0],
      definition,
      [],
      definition.tests,
      storageDir,
    );
  });

  it('navigates to HTTP logs flow when no tests', async () => {
    const definition = { name: 'my-def', tests: [] };
    const instanceDetail = { id: 'inst-1', items: [] };

    mockSelectMenu.mockResolvedValueOnce({
      value: instances[0],
      index: 0,
    });
    mockFetchJson
      .mockResolvedValueOnce(definition)
      .mockResolvedValueOnce(instanceDetail);
    mockShowHttpLogsFlow.mockResolvedValueOnce('exit');

    await inspectRun(ctUrl, runId, instances, storageDir);

    expect(mockShowHttpLogsFlow).toHaveBeenCalledWith(
      ctUrl,
      instances[0],
      definition,
      [],
    );
  });

  it('returns when user escapes from menu', async () => {
    mockSelectMenu.mockResolvedValueOnce(null);

    await inspectRun(ctUrl, runId, instances, storageDir);

    expect(mockFetchJson).not.toHaveBeenCalled();
    expect(mockShowTestStepsFlow).not.toHaveBeenCalled();
    expect(mockShowHttpLogsFlow).not.toHaveBeenCalled();
  });

  it('loops back to picker after viewing details with back navigation', async () => {
    const definition = {
      name: 'my-def',
      tests: [{ name: 'suite-1', steps: [{ name: 'step-1' }] }],
    };
    const instanceDetail = { id: 'inst-1', items: [] };

    // First pick: user selects instance, views tests, navigates back
    mockSelectMenu
      .mockResolvedValueOnce({ value: instances[0], index: 0 })
      .mockResolvedValueOnce(null); // second time: escape

    mockFetchJson
      .mockResolvedValueOnce(definition)
      .mockResolvedValueOnce(instanceDetail);
    mockShowTestStepsFlow.mockResolvedValueOnce('back');

    await inspectRun(ctUrl, runId, instances, storageDir);

    // selectMenu called twice: once for first pick, once after 'back'
    expect(mockSelectMenu).toHaveBeenCalledTimes(2);
  });

  it('also navigates to HTTP logs flow when tests is undefined', async () => {
    const definition = { name: 'my-def' }; // no tests field
    const instanceDetail = { id: 'inst-1', items: [] };

    mockSelectMenu.mockResolvedValueOnce({
      value: instances[0],
      index: 0,
    });
    mockFetchJson
      .mockResolvedValueOnce(definition)
      .mockResolvedValueOnce(instanceDetail);
    mockShowHttpLogsFlow.mockResolvedValueOnce('exit');

    await inspectRun(ctUrl, runId, instances, storageDir);

    expect(mockShowHttpLogsFlow).toHaveBeenCalled();
    expect(mockShowTestStepsFlow).not.toHaveBeenCalled();
  });
});
