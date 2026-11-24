import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('../lib/find-bin', () => ({ findDokkimiBin: jest.fn() }));
jest.mock('../lib/ct-client', () => ({ ctFetchOrNull: jest.fn() }));
jest.mock('../lib/update-status', () => ({ getAvailableUpdate: () => null }));

import { findDokkimiBin } from '../lib/find-bin';
import { ctFetchOrNull } from '../lib/ct-client';
import { createMockServer, parseContent } from './__helpers__/mock-server';
import { registerRunTests } from './run-tests';

const mockFetch = ctFetchOrNull as jest.Mock;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-tests-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true });
});

/** Runs the tool with a CLI that prints `lines` and exits with `code`. */
async function runTests(lines: string[], code: number) {
  const bin = path.join(dir, 'cli.js');
  fs.writeFileSync(
    bin,
    `console.log(${JSON.stringify(lines.join('\n'))}); process.exitCode = ${code};`,
  );
  (findDokkimiBin as jest.Mock).mockReturnValue(bin);
  const { server, call } = createMockServer();
  registerRunTests(server);
  const result = await call('run_tests');
  return { ...parseContent(result), isError: result.isError };
}

/** Control Tower knows run-1, and an earlier run that passed. */
function storeRun(status: string, instance: Record<string, unknown>) {
  const run = (runId: string, rest: object) => ({
    runId,
    status: 'COMPLETED',
    instances: [
      { id: 'i', name: 'n', status: 'STOPPED', testStatus: 'PASSED' },
    ],
    ...rest,
  });
  mockFetch.mockImplementation(async (url: string) =>
    url === '/runs/run-1/status'
      ? run('run-1', {
          status,
          instances: [{ id: 'i1', name: 'n', ...instance }],
        })
      : run('earlier', {}),
  );
}

const started = ['[Dokkimi] Run run-1', '[Dokkimi] Running 1 definition...'];

describe('run_tests', () => {
  it('reports the run it started', async () => {
    storeRun('COMPLETED', { status: 'STOPPED', testStatus: 'PASSED' });
    expect(await runTests(started, 0)).toEqual({
      success: true,
      isError: false,
      runId: 'run-1',
      summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
      instances: [{ id: 'i1', name: 'n', status: 'PASSED' }],
    });
  });

  it('fails when a test failed', async () => {
    storeRun('FAILED', { status: 'STOPPED', testStatus: 'FAILED' });
    expect(await runTests(started, 1)).toMatchObject({
      success: false,
      isError: true,
      runId: 'run-1',
      summary: { failed: 1 },
    });
  });

  it('fails when the run was cancelled', async () => {
    storeRun('CANCELLED', { status: 'STOPPED', testStatus: null });
    expect(await runTests(started, 1)).toMatchObject({
      success: false,
      isError: true,
      runId: 'run-1',
      error: 'dokkimi run exited with code 1',
      summary: { total: 1, passed: 0 },
    });
  });

  it.each([
    [
      'definition is invalid',
      '\x1b[31merror\x1b[0m  no steps',
      'error  no steps',
      1,
    ],
    ['target matches nothing', 'No definitions', 'No definitions', 0],
  ])(
    'fails without using an earlier run when the %s',
    async (_, line, output, code) => {
      storeRun('COMPLETED', {});
      const result = await runTests([line], code);
      expect(result).toEqual({
        success: false,
        isError: true,
        error: `No run was started (dokkimi run exited with code ${code})`,
        output: [output],
        summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
        instances: [],
      });
      expect(mockFetch).not.toHaveBeenCalledWith(
        '/runs/latest',
        expect.anything(),
      );
    },
  );

  it('fails when the results cannot be read', async () => {
    mockFetch.mockResolvedValue(null);
    expect(await runTests(started, 0)).toMatchObject({
      success: false,
      isError: true,
      runId: 'run-1',
      error: expect.stringContaining('Could not read the results'),
    });
  });
});
