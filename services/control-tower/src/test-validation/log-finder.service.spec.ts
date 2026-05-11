import { LogFinderService, stepTimeWindow } from './log-finder.service';
import { StepExecution } from '@dokkimi/config';
import { HttpLog } from '@prisma/client';

function makeStepExecution(overrides?: Partial<StepExecution>): StepExecution {
  return {
    stepIndex: 0,
    startTime: '2024-01-01T00:00:01.000Z',
    endTime: '2024-01-01T00:00:02.000Z',
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
    responseHeaders: {},
    requestBody: null,
    responseBody: null,
    timestamp: new Date('2024-01-01T00:00:01.500Z'),
    requestSentAt: new Date('2024-01-01T00:00:01.500Z'),
    responseReceivedAt: new Date('2024-01-01T00:00:01.600Z'),
    duration: 100,
    ...overrides,
  } as HttpLog;
}

describe('stepTimeWindow', () => {
  it('adds 500ms buffer on each side', () => {
    const exec = makeStepExecution({
      startTime: '2024-01-01T00:00:01.000Z',
      endTime: '2024-01-01T00:00:02.000Z',
    });
    const { startTime, endTime } = stepTimeWindow(exec);
    expect(startTime.getTime()).toBe(
      new Date('2024-01-01T00:00:00.500Z').getTime(),
    );
    expect(endTime.getTime()).toBe(
      new Date('2024-01-01T00:00:02.500Z').getTime(),
    );
  });
});

describe('LogFinderService', () => {
  let service: LogFinderService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      databaseLog: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    service = new LogFinderService(mockPrisma);
  });

  describe('matchUrl', () => {
    it('returns true for empty matchUrl', () => {
      expect(service.matchUrl('', 'my-service', '/api/users')).toBe(true);
    });

    it('matches path-only (starts with /)', () => {
      expect(service.matchUrl('/api/users', null, '/api/users')).toBe(true);
      expect(service.matchUrl('/api/users', null, '/other')).toBe(false);
    });

    it('matches service-only (no slash)', () => {
      expect(service.matchUrl('my-service', 'my-service', '/anything')).toBe(
        true,
      );
      expect(service.matchUrl('my-service', 'other', '/anything')).toBe(false);
    });

    it('matches service + path', () => {
      expect(
        service.matchUrl('my-service/api/users', 'my-service', '/api/users'),
      ).toBe(true);
      expect(
        service.matchUrl('my-service/api/users', 'other', '/api/users'),
      ).toBe(false);
      expect(
        service.matchUrl('my-service/api/users', 'my-service', '/other'),
      ).toBe(false);
    });

    it('path matching uses includes (substring)', () => {
      expect(service.matchUrl('/users', null, '/api/users/123')).toBe(true);
    });
  });

  describe('findDirectRequestLog', () => {
    const stepExec = makeStepExecution();

    it('returns undefined when no logs', () => {
      const result = service.findDirectRequestLog(
        [],
        { method: 'GET', url: 'my-service/api/users' } as any,
        stepExec,
      );
      expect(result).toBeUndefined();
    });

    it('returns matching log', () => {
      const log = makeHttpLog();
      const result = service.findDirectRequestLog(
        [log],
        { method: 'GET', url: 'my-service/api/users' } as any,
        stepExec,
      );
      expect(result).toBe(log);
    });

    it('filters by method', () => {
      const log = makeHttpLog({ method: 'POST' });
      const result = service.findDirectRequestLog(
        [log],
        { method: 'GET', url: 'my-service/api/users' } as any,
        stepExec,
      );
      expect(result).toBeUndefined();
    });

    it('filters by time window', () => {
      const log = makeHttpLog({
        timestamp: new Date('2023-06-01T00:00:00Z'),
      });
      const result = service.findDirectRequestLog(
        [log],
        { method: 'GET', url: 'my-service/api/users' } as any,
        stepExec,
      );
      expect(result).toBeUndefined();
    });

    it('filters by target from url', () => {
      const log = makeHttpLog({ target: 'other-service' });
      const result = service.findDirectRequestLog(
        [log],
        { method: 'GET', url: 'my-service/api/users' } as any,
        stepExec,
      );
      expect(result).toBeUndefined();
    });

    it('filters by path from url', () => {
      const log = makeHttpLog({ url: '/other/path' });
      const result = service.findDirectRequestLog(
        [log],
        { method: 'GET', url: 'my-service/api/users' } as any,
        stepExec,
      );
      expect(result).toBeUndefined();
    });

    it('matches when action has no url', () => {
      const log = makeHttpLog();
      const result = service.findDirectRequestLog(
        [log],
        { method: 'GET' } as any,
        stepExec,
      );
      expect(result).toBe(log);
    });

    it('picks log closest to midpoint when multiple match', () => {
      const earlyLog = makeHttpLog({
        id: 'early',
        timestamp: new Date('2024-01-01T00:00:01.100Z'),
      });
      const midLog = makeHttpLog({
        id: 'mid',
        timestamp: new Date('2024-01-01T00:00:01.500Z'),
      });
      const lateLog = makeHttpLog({
        id: 'late',
        timestamp: new Date('2024-01-01T00:00:01.900Z'),
      });
      const result = service.findDirectRequestLog(
        [earlyLog, lateLog, midLog],
        { method: 'GET' } as any,
        stepExec,
      );
      expect(result!.id).toBe('mid');
    });
  });

  describe('findDirectDatabaseLog', () => {
    const stepExec = makeStepExecution();

    it('returns null when no candidates found', async () => {
      mockPrisma.databaseLog.findMany.mockResolvedValue([]);
      const result = await service.findDirectDatabaseLog(
        'inst-1',
        { database: 'mydb', query: 'SELECT 1' } as any,
        stepExec,
      );
      expect(result).toBeNull();
    });

    it('queries with correct where clause', async () => {
      mockPrisma.databaseLog.findMany.mockResolvedValue([]);
      await service.findDirectDatabaseLog(
        'inst-1',
        { database: 'mydb', query: '  SELECT 1  ' } as any,
        stepExec,
      );
      const call = mockPrisma.databaseLog.findMany.mock.calls[0][0];
      expect(call.where.instanceId).toBe('inst-1');
      expect(call.where.databaseName).toBe('mydb');
      expect(call.where.query).toBe('SELECT 1');
    });

    it('returns single candidate directly', async () => {
      const log = {
        id: 'db-1',
        timestamp: new Date('2024-01-01T00:00:01.500Z'),
      };
      mockPrisma.databaseLog.findMany.mockResolvedValue([log]);
      const result = await service.findDirectDatabaseLog(
        'inst-1',
        { database: 'mydb', query: 'SELECT 1' } as any,
        stepExec,
      );
      expect(result).toBe(log);
    });

    it('picks candidate closest to midpoint', async () => {
      const early = {
        id: 'early',
        timestamp: new Date('2024-01-01T00:00:01.100Z'),
      };
      const mid = {
        id: 'mid',
        timestamp: new Date('2024-01-01T00:00:01.500Z'),
      };
      mockPrisma.databaseLog.findMany.mockResolvedValue([early, mid]);
      const result = await service.findDirectDatabaseLog(
        'inst-1',
        { database: 'mydb', query: 'SELECT 1' } as any,
        stepExec,
      );
      expect(result!.id).toBe('mid');
    });
  });
});
