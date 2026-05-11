import {
  DocumentAssemblerService,
  normalizeHeaderKeys,
} from './document-assembler.service';
import { HttpLog } from '@prisma/client';

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
    requestHeaders: { 'Content-Type': 'application/json' },
    responseHeaders: { 'X-Request-Id': 'abc' },
    requestBody: { query: 'test' },
    responseBody: { name: 'Alice' },
    timestamp: new Date('2024-01-01T00:00:01.000Z'),
    requestSentAt: new Date('2024-01-01T00:00:01.000Z'),
    responseReceivedAt: new Date('2024-01-01T00:00:01.100Z'),
    duration: 100,
    ...overrides,
  } as HttpLog;
}

describe('normalizeHeaderKeys', () => {
  it('lowercases all keys', () => {
    const result = normalizeHeaderKeys({
      'Content-Type': 'text/html',
      'X-Custom': 'value',
    });
    expect(result['content-type']).toBe('text/html');
    expect(result['x-custom']).toBe('value');
  });

  it('returns empty object for null', () => {
    expect(normalizeHeaderKeys(null)).toEqual({});
  });

  it('returns empty object for undefined', () => {
    expect(normalizeHeaderKeys(undefined)).toEqual({});
  });

  it('returns empty object for non-object', () => {
    expect(normalizeHeaderKeys('string')).toEqual({});
  });
});

describe('DocumentAssemblerService', () => {
  let service: DocumentAssemblerService;
  let mockPrisma: any;
  let mockLogFinder: any;

  beforeEach(() => {
    mockPrisma = {
      testExecutionLog: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    mockLogFinder = {
      findDirectRequestLog: jest.fn(),
      findDirectDatabaseLog: jest.fn(),
    };
    service = new DocumentAssemblerService(mockPrisma, mockLogFinder);
  });

  describe('assembleHttpDocument', () => {
    it('returns empty object for null log', () => {
      expect(service.assembleHttpDocument(null)).toEqual({});
    });

    it('assembles correct shape from log', () => {
      const log = makeHttpLog();
      const doc = service.assembleHttpDocument(log);
      expect(doc.request.method).toBe('GET');
      expect(doc.request.url).toBe('/api/users');
      expect(doc.request.body).toEqual({ query: 'test' });
      expect(doc.response.status).toBe(200);
      expect(doc.response.body).toEqual({ name: 'Alice' });
      expect(doc.responseTime).toBe(100);
    });

    it('normalizes header keys to lowercase', () => {
      const log = makeHttpLog();
      const doc = service.assembleHttpDocument(log);
      expect(doc.request.header['content-type']).toBe('application/json');
      expect(doc.response.header['x-request-id']).toBe('abc');
    });

    it('defaults body to {} when null', () => {
      const log = makeHttpLog({ requestBody: null, responseBody: null });
      const doc = service.assembleHttpDocument(log);
      expect(doc.request.body).toEqual({});
      expect(doc.response.body).toEqual({});
    });

    it('calculates responseTime as null when timestamps missing', () => {
      const log = makeHttpLog({
        requestSentAt: null as any,
        responseReceivedAt: null as any,
      });
      const doc = service.assembleHttpDocument(log);
      expect(doc.responseTime).toBeNull();
    });
  });

  describe('assembleStepDocument', () => {
    const stepExec = {
      stepIndex: 0,
      startTime: '2024-01-01T00:00:00Z',
      endTime: '2024-01-01T00:00:01Z',
    };

    it('returns empty object for wait action', async () => {
      const step = { action: { type: 'wait' } } as any;
      const doc = await service.assembleStepDocument(
        'inst-1',
        step,
        0,
        stepExec,
        [],
      );
      expect(doc).toEqual({});
    });

    it('calls assembleDbDocument for dbQuery action', async () => {
      mockLogFinder.findDirectDatabaseLog.mockResolvedValue({
        success: true,
        data: [{ id: 1 }],
        rowsAffected: 1,
        error: null,
        duration: 50,
      });
      const step = {
        action: { type: 'dbQuery', database: 'mydb', query: 'SELECT 1' },
      } as any;
      const doc = await service.assembleStepDocument(
        'inst-1',
        step,
        0,
        stepExec,
        [],
      );
      expect(doc.success).toBe(true);
      expect(doc.data).toEqual([{ id: 1 }]);
    });

    it('returns empty object for dbQuery when no log found', async () => {
      mockLogFinder.findDirectDatabaseLog.mockResolvedValue(null);
      const step = {
        action: { type: 'dbQuery', database: 'mydb', query: 'SELECT 1' },
      } as any;
      const doc = await service.assembleStepDocument(
        'inst-1',
        step,
        0,
        stepExec,
        [],
      );
      expect(doc).toEqual({});
    });

    it('calls assembleUiDocument for ui action', async () => {
      mockPrisma.testExecutionLog.findMany.mockResolvedValue([
        { variables: { a: '1' } },
        { variables: { a: '1', b: '2' } },
      ]);
      const step = { action: { type: 'ui' } } as any;
      const doc = await service.assembleStepDocument(
        'inst-1',
        step,
        0,
        stepExec,
        [],
      );
      expect(doc.extracted).toEqual({ b: '2' });
    });

    it('calls findDirectRequestLog for HTTP action', async () => {
      const log = makeHttpLog();
      mockLogFinder.findDirectRequestLog.mockReturnValue(log);
      const step = {
        action: { type: 'httpRequest', method: 'GET', url: 'svc/api' },
      } as any;
      const doc = await service.assembleStepDocument(
        'inst-1',
        step,
        0,
        stepExec,
        [log],
      );
      expect(doc.response.status).toBe(200);
    });

    it('returns empty object for HTTP action when no log found', async () => {
      mockLogFinder.findDirectRequestLog.mockReturnValue(undefined);
      const step = {
        action: { type: 'httpRequest', method: 'GET', url: 'svc/api' },
      } as any;
      const doc = await service.assembleStepDocument(
        'inst-1',
        step,
        0,
        stepExec,
        [],
      );
      expect(doc).toEqual({});
    });
  });

  describe('assembleExtractDocument', () => {
    const stepExec = {
      stepIndex: 0,
      startTime: '2024-01-01T00:00:00Z',
      endTime: '2024-01-01T00:00:01Z',
    };

    it('returns empty object for wait action', async () => {
      const step = { action: { type: 'wait' } } as any;
      const doc = await service.assembleExtractDocument(
        'inst-1',
        step,
        0,
        stepExec,
        [],
      );
      expect(doc).toEqual({});
    });

    it('builds flat document for HTTP action', async () => {
      const log = makeHttpLog({ statusCode: 201 });
      mockLogFinder.findDirectRequestLog.mockReturnValue(log);
      const step = {
        action: { type: 'httpRequest', method: 'POST', url: 'svc/api' },
      } as any;
      const doc = await service.assembleExtractDocument(
        'inst-1',
        step,
        0,
        stepExec,
        [log],
      );
      expect(doc.statusCode).toBe(201);
      expect(doc.body).toEqual({ name: 'Alice' });
      expect(doc.headers['x-request-id']).toBe('abc');
    });

    it('returns empty object for HTTP action when no log found', async () => {
      mockLogFinder.findDirectRequestLog.mockReturnValue(undefined);
      const step = {
        action: { type: 'httpRequest', method: 'GET', url: 'svc/api' },
      } as any;
      const doc = await service.assembleExtractDocument(
        'inst-1',
        step,
        0,
        stepExec,
        [],
      );
      expect(doc).toEqual({});
    });

    it('delegates to assembleDbDocument for dbQuery', async () => {
      mockLogFinder.findDirectDatabaseLog.mockResolvedValue({
        success: true,
        data: [],
        rowsAffected: 0,
        error: null,
        duration: 10,
      });
      const step = {
        action: { type: 'dbQuery', database: 'db', query: 'SELECT 1' },
      } as any;
      const doc = await service.assembleExtractDocument(
        'inst-1',
        step,
        0,
        stepExec,
        [],
      );
      expect(doc.success).toBe(true);
    });

    it('delegates to assembleUiDocument for ui action', async () => {
      mockPrisma.testExecutionLog.findMany.mockResolvedValue([
        { variables: {} },
        { variables: { x: 'val' } },
      ]);
      const step = { action: { type: 'ui' } } as any;
      const doc = await service.assembleExtractDocument(
        'inst-1',
        step,
        0,
        stepExec,
        [],
      );
      expect(doc.extracted).toEqual({ x: 'val' });
    });
  });

  describe('assembleUiDocument (via assembleStepDocument)', () => {
    const stepExec = {
      stepIndex: 0,
      startTime: '2024-01-01T00:00:00Z',
      endTime: '2024-01-01T00:00:01Z',
    };
    const step = { action: { type: 'ui' } } as any;

    it('returns empty object when no logs', async () => {
      mockPrisma.testExecutionLog.findMany.mockResolvedValue([]);
      const doc = await service.assembleStepDocument(
        'inst-1',
        step,
        0,
        stepExec,
        [],
      );
      expect(doc).toEqual({});
    });

    it('extracts new variables from final snapshot', async () => {
      mockPrisma.testExecutionLog.findMany.mockResolvedValue([
        { variables: { existing: 'val1' } },
        { variables: { existing: 'val1', newVar: 'val2' } },
      ]);
      const doc = await service.assembleStepDocument(
        'inst-1',
        step,
        0,
        stepExec,
        [],
      );
      expect(doc.extracted).toEqual({ newVar: 'val2' });
    });

    it('extracts changed variables', async () => {
      mockPrisma.testExecutionLog.findMany.mockResolvedValue([
        { variables: { x: 'old' } },
        { variables: { x: 'new' } },
      ]);
      const doc = await service.assembleStepDocument(
        'inst-1',
        step,
        0,
        stepExec,
        [],
      );
      expect(doc.extracted).toEqual({ x: 'new' });
    });

    it('handles null variables gracefully', async () => {
      mockPrisma.testExecutionLog.findMany.mockResolvedValue([
        { variables: null },
        { variables: null },
      ]);
      const doc = await service.assembleStepDocument(
        'inst-1',
        step,
        0,
        stepExec,
        [],
      );
      expect(doc.extracted).toEqual({});
    });
  });
});
