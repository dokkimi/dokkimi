jest.mock('@dokkimi/config', () => ({
  loadConfig: jest.fn(() => ({
    services: { controlTower: { host: 'localhost', port: 19001 } },
    storage: { dir: '/tmp/dokkimi-storage' },
  })),
  buildServiceUrl: jest.fn(() => 'http://localhost:19001'),
  dumpPath: jest.fn(
    (projectPath: string, createdAt: Date, failed: boolean) =>
      `/mock-home/.dokkimi/runs/mock/project/20260101-000000/${failed ? 'dump_failed.json' : 'dump.json'}`,
  ),
}));
jest.mock('../lib/cli-utils', () => ({
  fetchJson: jest.fn(),
  fetchJsonOrThrow: jest.fn(),
}));

jest.mock('@dokkimi/telemetry', () => ({
  trackEvent: jest.fn(),
}));

jest.mock('@dokkimi/definition-resolver', () => ({
  resolveDefinitions: jest.fn(() => ({ definitions: [] })),
}));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    mkdirSync: jest.fn(),
    createWriteStream: jest.fn(),
    renameSync: jest.fn(),
    rmSync: jest.fn(),
    readFileSync: actual.readFileSync,
  };
});

import * as fs from 'fs';
import { fetchJson, fetchJsonOrThrow } from '../lib/cli-utils';
import { trackEvent } from '@dokkimi/telemetry';
import { dump } from './dump';

const mockFetchJson = fetchJson as jest.MockedFunction<typeof fetchJson>;
const mockFetchStrict = fetchJsonOrThrow as jest.MockedFunction<
  typeof fetchJsonOrThrow
>;
const mockMkdirSync = fs.mkdirSync as jest.MockedFunction<typeof fs.mkdirSync>;
const mockCreateWriteStream = fs.createWriteStream as jest.MockedFunction<
  typeof fs.createWriteStream
>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockLatestRun = {
  runId: 'run-1',
  status: 'COMPLETED',
  createdAt: '2026-01-01T00:00:00Z',
  completedAt: '2026-01-01T00:01:00Z',
  instances: [
    {
      id: 'inst-1',
      name: 'my-test',
      status: 'STOPPED',
      testStatus: 'PASSED',
    },
    {
      id: 'inst-2',
      name: 'my-test-2',
      status: 'FAILED',
      testStatus: 'FAILED',
      errorMessage: 'assertion failed',
    },
  ],
};

function makeMockStream() {
  const chunks: string[] = [];
  const stream = {
    write: jest.fn((data: string) => chunks.push(data)),
    end: jest.fn((cb: () => void) => cb()),
    destroy: jest.fn(),
  };
  return { stream, chunks };
}

function setupFetchJsonForDump() {
  mockFetchJson.mockImplementation(async (url: string) => {
    if (url.includes('/runs/latest')) {
      return mockLatestRun as any;
    }
    if (url.includes('/definition')) {
      return { items: [], tests: [] } as any;
    }
    if (url.includes('/namespaces/instances/')) {
      return { items: [{ name: 'svc-a', type: 'service' }] } as any;
    }
    if (url.includes('/logs/http/')) {
      return { logs: [] } as any;
    }
    if (url.includes('/logs/database/')) {
      return { logs: [] } as any;
    }
    if (url.includes('/logs/console/')) {
      return { logs: [] } as any;
    }
    if (url.includes('/logs/test-execution/')) {
      return { logs: [] } as any;
    }
    if (url.includes('/logs/assertion-results/')) {
      return [] as any;
    }
    if (url.includes('/artifacts/')) {
      return { artifacts: [] } as any;
    }
    return null;
  });
  // The instance data goes through the strict fetch
  mockFetchStrict.mockImplementation((url: string) => mockFetchJson(url));
}

let processExitSpy: jest.SpyInstance;
let consoleLogSpy: jest.SpyInstance;
let consoleErrorSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });
  consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  processExitSpy.mockRestore();
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dump', () => {
  it('prints help and exits on --help', async () => {
    await expect(dump(['--help'])).rejects.toThrow('process.exit');
    expect(processExitSpy).toHaveBeenCalledWith(0);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Usage: dokkimi dump'),
    );
  });

  it('prints help and exits on -h', async () => {
    await expect(dump(['-h'])).rejects.toThrow('process.exit');
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it('exports run data to default path', async () => {
    setupFetchJsonForDump();

    const { stream, chunks } = makeMockStream();
    mockCreateWriteStream.mockReturnValue(stream as unknown as fs.WriteStream);

    await dump([]);

    expect(mockCreateWriteStream).toHaveBeenCalledWith(
      expect.stringContaining('dump.json'),
    );
    expect(mockMkdirSync).toHaveBeenCalled();

    const output = chunks.join('');
    expect(output).toContain('"runId"');
    expect(output).toContain('run-1');
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Dump written to'),
    );
    expect(trackEvent).toHaveBeenCalledWith(
      'cli_dump_result',
      expect.objectContaining({ instance_count: 2 }),
    );
  });

  it('--failed flag filters to failed instances only', async () => {
    setupFetchJsonForDump();

    const { stream, chunks } = makeMockStream();
    mockCreateWriteStream.mockReturnValue(stream as unknown as fs.WriteStream);

    await dump(['--failed']);

    expect(trackEvent).toHaveBeenCalledWith(
      'cli_dump_result',
      expect.objectContaining({ instance_count: 1, failed_only: true }),
    );

    // Only the failed instance should appear
    const output = chunks.join('');
    expect(output).toContain('my-test-2');
  });

  it('-o <file> writes to custom path', async () => {
    setupFetchJsonForDump();

    const { stream } = makeMockStream();
    mockCreateWriteStream.mockReturnValue(stream as unknown as fs.WriteStream);

    await dump(['-o', '/tmp/custom-dump.json']);

    expect(mockCreateWriteStream).toHaveBeenCalledWith(
      '/tmp/custom-dump.json.partial',
    );
    expect(fs.renameSync).toHaveBeenCalledWith(
      '/tmp/custom-dump.json.partial',
      '/tmp/custom-dump.json',
    );
  });

  // Before, a failed fetch became an empty list and the dump looked complete
  it('fails, leaving no dump, when a fetch fails', async () => {
    setupFetchJsonForDump();
    mockFetchStrict.mockImplementation(async (url: string) => {
      if (url.includes('/logs/http/')) {
        throw new Error(`HTTP 500 fetching ${url}`);
      }
      return mockFetchJson(url);
    });
    const { stream } = makeMockStream();
    mockCreateWriteStream.mockReturnValue(stream as unknown as fs.WriteStream);

    await expect(dump(['-o', '/tmp/d.json'])).rejects.toThrow('process.exit');

    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^Dump failed: HTTP 500 fetching .*\/logs\/http\//),
    );
    expect(fs.rmSync).toHaveBeenCalledWith('/tmp/d.json.partial', {
      force: true,
    });
    expect(fs.renameSync).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Dump written to'),
    );
  });

  it('allows a missing definition', async () => {
    setupFetchJsonForDump();
    mockFetchStrict.mockImplementation(async (url: string, opts) => {
      if (url.includes('/definition')) {
        expect(opts?.allow404).toBe(true);
        return null;
      }
      return mockFetchJson(url);
    });
    const { stream } = makeMockStream();
    mockCreateWriteStream.mockReturnValue(stream as unknown as fs.WriteStream);

    await dump(['-o', '/tmp/d.json']);

    expect(fs.renameSync).toHaveBeenCalled();
  });

  // Before, a list cut off at its limit looked complete
  it('names each list cut off at its limit, with its total', async () => {
    setupFetchJsonForDump();
    mockFetchStrict.mockImplementation(async (url: string) => {
      if (url.includes('/logs/http/')) {
        return { logs: [{ method: 'GET' }, { method: 'POST' }], total: 812 };
      }
      if (url.includes('/logs/console/')) {
        return { logs: [{ log: 'a' }], total: 1 };
      }
      return mockFetchJson(url);
    });
    const { stream, chunks } = makeMockStream();
    mockCreateWriteStream.mockReturnValue(stream as unknown as fs.WriteStream);

    await dump(['-o', '/tmp/d.json']);

    const parsed = JSON.parse(chunks.join(''));
    expect(parsed.instances[0].truncated).toEqual({
      httpLogs: { included: 2, total: 812 },
    });
  });

  it('handles no latest run gracefully', async () => {
    mockFetchJson.mockResolvedValue(null);

    await expect(dump([])).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('No run history found'),
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('writes valid JSON structure', async () => {
    setupFetchJsonForDump();

    const { stream, chunks } = makeMockStream();
    mockCreateWriteStream.mockReturnValue(stream as unknown as fs.WriteStream);

    await dump([]);

    const output = chunks.join('');
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('runId', 'run-1');
    expect(parsed).toHaveProperty('status', 'COMPLETED');
    expect(parsed).toHaveProperty('instances');
    expect(Array.isArray(parsed.instances)).toBe(true);
    expect(parsed.instances).toHaveLength(2);
    expect(parsed.instances[0]).toHaveProperty('name');
    expect(parsed.instances[0]).toHaveProperty('httpLogs');
    expect(parsed.instances[0]).toHaveProperty('consoleLogs');
    expect(parsed.instances[0]).toHaveProperty('assertionResults');
  });

  it("removes Dokkimi's ids and keeps the user's", async () => {
    const row = { id: 'x', instanceId: 'x', instanceItemId: 'x' };
    const data = [{ id: 1, instanceId: 2, instanceItemId: 3 }];
    const answers: Record<string, unknown> = {
      '/runs/latest': mockLatestRun,
      '/definition': { tests: data },
      '/logs/http/': { logs: [{ ...row, responseBody: data }] },
      '/logs/database/': { logs: [{ ...row, data }] },
      '/logs/console/': { logs: [{ ...row, data }] },
      '/logs/message/': { logs: [{ ...row, body: data }] },
      '/logs/test-execution/': { logs: [{ ...row, variables: data }] },
      '/logs/assertion-results/': [{ ...row, expected: data }],
    };
    mockFetchJson.mockImplementation(async (url: string) => {
      const key = Object.keys(answers).find((k) => url.includes(k));
      return (key ? answers[key] : null) as any;
    });
    const { stream, chunks } = makeMockStream();
    mockCreateWriteStream.mockReturnValue(stream as unknown as fs.WriteStream);

    await dump([]);

    expect(JSON.parse(chunks.join('')).instances[0]).toMatchObject({
      definition: { tests: data },
      httpLogs: [{ responseBody: data }],
      databaseLogs: [{ data }],
      consoleLogs: [{ data }],
      messageLogs: [{ body: data }],
      testExecutionLogs: [{ variables: data }],
      assertionResults: [{ expected: data }],
    });
    expect(chunks.join('')).not.toContain('"x"');
  });
});
