import { validateHttpCallBlock } from './http-call-block-validator';
import { AssertionBlock, StepExecution } from '@dokkimi/config';
import { HttpLog } from '@prisma/client';
import { LogFinderService } from '../log-finder.service';
import { DocumentAssemblerService } from '../document-assembler.service';

function makeStepExecution(overrides?: Partial<StepExecution>): StepExecution {
  return {
    stepIndex: 0,
    startTime: '2024-01-01T00:00:00.000Z',
    endTime: '2024-01-01T00:00:01.000Z',
    ...overrides,
  };
}

function makeHttpLog(overrides?: Partial<HttpLog>): HttpLog {
  return {
    id: 'log-1',
    instanceId: 'inst-1',
    instanceItemId: null,
    origin: 'test-agent',
    target: 'my-service',
    method: 'GET',
    url: '/api/users',
    statusCode: 200,
    requestHeaders: {},
    responseHeaders: { 'content-type': 'application/json' },
    requestBody: null,
    responseBody: { name: 'Alice' },
    timestamp: new Date('2024-01-01T00:00:00.500Z'),
    requestSentAt: new Date('2024-01-01T00:00:00.500Z'),
    responseReceivedAt: new Date('2024-01-01T00:00:00.600Z'),
    duration: 100,
    ...overrides,
  } as HttpLog;
}

const mockLogFinder = {
  matchUrl: jest.fn((matchUrl: string, target: string | null, url: string) => {
    if (matchUrl.startsWith('/')) {
      return url.includes(matchUrl);
    }
    const slashIdx = matchUrl.indexOf('/');
    const service = slashIdx >= 0 ? matchUrl.substring(0, slashIdx) : matchUrl;
    const path = slashIdx >= 0 ? matchUrl.substring(slashIdx) : '';
    if (service && target !== service) {
      return false;
    }
    if (path && !url.includes(path)) {
      return false;
    }
    return true;
  }),
} as unknown as LogFinderService;

const mockDocAssembler = {
  assembleHttpDocument: jest.fn((log: HttpLog) => ({
    request: {
      method: log.method,
      url: log.url,
      header: log.requestHeaders ?? {},
      body: log.requestBody ?? {},
    },
    response: {
      status: log.statusCode,
      header: log.responseHeaders ?? {},
      body: log.responseBody ?? {},
    },
    responseTime: 100,
  })),
} as unknown as DocumentAssemblerService;

describe('validateHttpCallBlock', () => {
  const stepExec = makeStepExecution();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns count failure when no logs match time window', () => {
    const block: AssertionBlock = {
      match: { origin: 'test-agent' },
      assertions: [],
    } as any;
    const outOfWindowLog = makeHttpLog({
      timestamp: new Date('2023-01-01T00:00:00Z'),
      requestSentAt: new Date('2023-01-01T00:00:00Z'),
    });
    const results = validateHttpCallBlock(
      block,
      stepExec,
      [outOfWindowLog],
      mockLogFinder,
      mockDocAssembler,
    );
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].resultKind).toBe('count');
  });

  it('filters by origin', () => {
    const block: AssertionBlock = {
      match: { origin: 'other-service' },
      assertions: [],
    } as any;
    const results = validateHttpCallBlock(
      block,
      stepExec,
      [makeHttpLog()],
      mockLogFinder,
      mockDocAssembler,
    );
    expect(results[0].passed).toBe(false);
  });

  it('filters by method', () => {
    const block: AssertionBlock = {
      match: { method: 'POST' },
      assertions: [],
    } as any;
    const results = validateHttpCallBlock(
      block,
      stepExec,
      [makeHttpLog({ method: 'GET' })],
      mockLogFinder,
      mockDocAssembler,
    );
    expect(results[0].passed).toBe(false);
  });

  it('filters by url using logFinder.matchUrl', () => {
    const block: AssertionBlock = {
      match: { url: 'other-service/api' },
      assertions: [],
    } as any;
    const results = validateHttpCallBlock(
      block,
      stepExec,
      [makeHttpLog()],
      mockLogFinder,
      mockDocAssembler,
    );
    expect(mockLogFinder.matchUrl).toHaveBeenCalled();
    expect(results[0].passed).toBe(false);
  });

  it('uses default count gte:1 when no count specified', () => {
    const block: AssertionBlock = {
      match: { origin: 'test-agent' },
      assertions: [],
    } as any;
    const results = validateHttpCallBlock(
      block,
      stepExec,
      [makeHttpLog()],
      mockLogFinder,
      mockDocAssembler,
    );
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    expect(results[0].resultKind).toBe('count');
  });

  it('validates explicit count', () => {
    const block: AssertionBlock = {
      match: { origin: 'test-agent' },
      count: { operator: 'eq', value: 2 },
      assertions: [],
    } as any;
    const results = validateHttpCallBlock(
      block,
      stepExec,
      [makeHttpLog()],
      mockLogFinder,
      mockDocAssembler,
    );
    expect(results[0].passed).toBe(false);
  });

  it('returns only count when count fails (skips assertions)', () => {
    const block: AssertionBlock = {
      match: { origin: 'test-agent' },
      count: { operator: 'eq', value: 0 },
      assertions: [{ path: 'response.status', operator: 'eq', value: 200 }],
    } as any;
    const results = validateHttpCallBlock(
      block,
      stepExec,
      [makeHttpLog()],
      mockLogFinder,
      mockDocAssembler,
    );
    expect(results).toHaveLength(1);
    expect(results[0].resultKind).toBe('count');
  });

  it('returns only count when no active assertions', () => {
    const block: AssertionBlock = {
      match: { origin: 'test-agent' },
      assertions: [
        {
          path: 'response.status',
          operator: 'eq',
          value: 200,
          disabled: true,
        },
      ],
    } as any;
    const results = validateHttpCallBlock(
      block,
      stepExec,
      [makeHttpLog()],
      mockLogFinder,
      mockDocAssembler,
    );
    expect(results).toHaveLength(1);
    expect(results[0].resultKind).toBe('count');
  });

  it('validates assertions with scope=all (default)', () => {
    const block: AssertionBlock = {
      match: { origin: 'test-agent' },
      assertions: [{ path: 'response.status', operator: 'eq', value: 200 }],
    } as any;
    const results = validateHttpCallBlock(
      block,
      stepExec,
      [makeHttpLog()],
      mockLogFinder,
      mockDocAssembler,
    );
    expect(results).toHaveLength(2);
    expect(results[0].resultKind).toBe('count');
    expect(results[1].passed).toBe(true);
    expect(results[1].resultKind).toBe('field');
  });

  it('scope=first validates only first log', () => {
    const block: AssertionBlock = {
      match: { origin: 'test-agent' },
      assertionScope: 'first',
      assertions: [{ path: 'response.status', operator: 'eq', value: 200 }],
    } as any;
    const log1 = makeHttpLog({ statusCode: 200 });
    const log2 = makeHttpLog({
      id: 'log-2',
      statusCode: 404,
      timestamp: new Date('2024-01-01T00:00:00.700Z'),
      requestSentAt: new Date('2024-01-01T00:00:00.700Z'),
    });
    const results = validateHttpCallBlock(
      block,
      stepExec,
      [log1, log2],
      mockLogFinder,
      mockDocAssembler,
    );
    expect(results[1].passed).toBe(true);
  });

  it('scope=last validates only last log', () => {
    const block: AssertionBlock = {
      match: { origin: 'test-agent' },
      assertionScope: 'last',
      assertions: [{ path: 'response.status', operator: 'eq', value: 404 }],
    } as any;
    const log1 = makeHttpLog({ statusCode: 200 });
    const log2 = makeHttpLog({
      id: 'log-2',
      statusCode: 404,
      timestamp: new Date('2024-01-01T00:00:00.700Z'),
      requestSentAt: new Date('2024-01-01T00:00:00.700Z'),
    });
    const results = validateHttpCallBlock(
      block,
      stepExec,
      [log1, log2],
      mockLogFinder,
      mockDocAssembler,
    );
    expect(results[1].passed).toBe(true);
  });

  it('scope=any passes if at least one log matches', () => {
    const block: AssertionBlock = {
      match: { origin: 'test-agent' },
      assertionScope: 'any',
      assertions: [{ path: 'response.status', operator: 'eq', value: 404 }],
    } as any;
    const log1 = makeHttpLog({ statusCode: 200 });
    const log2 = makeHttpLog({
      id: 'log-2',
      statusCode: 404,
      timestamp: new Date('2024-01-01T00:00:00.700Z'),
      requestSentAt: new Date('2024-01-01T00:00:00.700Z'),
    });
    const results = validateHttpCallBlock(
      block,
      stepExec,
      [log1, log2],
      mockLogFinder,
      mockDocAssembler,
    );
    const fieldResults = results.filter((r) => r.resultKind === 'field');
    expect(fieldResults[0].passed).toBe(true);
  });

  it('scope=any fails when no log matches', () => {
    const block: AssertionBlock = {
      match: { origin: 'test-agent' },
      assertionScope: 'any',
      assertions: [{ path: 'response.status', operator: 'eq', value: 500 }],
    } as any;
    const results = validateHttpCallBlock(
      block,
      stepExec,
      [makeHttpLog({ statusCode: 200 })],
      mockLogFinder,
      mockDocAssembler,
    );
    const fieldResults = results.filter((r) => r.resultKind === 'field');
    expect(fieldResults[0].passed).toBe(false);
    expect(fieldResults[0].error).toContain('No matching log passed');
  });

  it('scope=all short-circuits on first failure', () => {
    const block: AssertionBlock = {
      match: { origin: 'test-agent' },
      assertions: [
        { path: 'response.status', operator: 'eq', value: 999 },
        { path: 'response.body.name', operator: 'eq', value: 'Alice' },
      ],
    } as any;
    const results = validateHttpCallBlock(
      block,
      stepExec,
      [makeHttpLog()],
      mockLogFinder,
      mockDocAssembler,
    );
    const fieldResults = results.filter((r) => r.resultKind === 'field');
    expect(fieldResults).toHaveLength(1);
    expect(fieldResults[0].passed).toBe(false);
  });

  it('skips disabled assertions', () => {
    const block: AssertionBlock = {
      match: { origin: 'test-agent' },
      assertions: [
        {
          path: 'response.status',
          operator: 'eq',
          value: 999,
          disabled: true,
        },
        { path: 'response.status', operator: 'eq', value: 200 },
      ],
    } as any;
    const results = validateHttpCallBlock(
      block,
      stepExec,
      [makeHttpLog()],
      mockLogFinder,
      mockDocAssembler,
    );
    const fieldResults = results.filter((r) => r.resultKind === 'field');
    expect(fieldResults).toHaveLength(1);
    expect(fieldResults[0].passed).toBe(true);
  });
});
