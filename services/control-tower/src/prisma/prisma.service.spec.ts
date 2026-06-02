import { PrismaService } from './prisma.service';

jest.mock('@prisma/client', () => {
  const mockClient = {
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    $queryRaw: jest.fn().mockResolvedValue([]),
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ '1': 1 }]),
    namespaceInstance: {},
    instanceItem: {},
    httpLog: {},
    consoleLog: {},
    databaseLog: {},
    testExecutionLog: {},
    assertionResult: {},
    artifact: {},
    run: {},
  };

  return {
    PrismaClient: jest.fn(() => mockClient),
    Prisma: { Sql: class {} },
    __mockClient: mockClient,
  };
});

jest.mock('@prisma/adapter-libsql', () => ({
  PrismaLibSql: jest.fn(),
}));

jest.mock('@prisma/adapter-pg', () => ({
  PrismaPg: jest.fn(),
}));

const { __mockClient } = jest.requireMock('@prisma/client');

describe('PrismaService', () => {
  const makeConfigService = (dbUrl?: string): any => ({
    get: jest.fn((key: string) => {
      if (key === 'DATABASE_URL') {
        return dbUrl;
      }
      return undefined;
    }),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    __mockClient.$connect.mockResolvedValue(undefined);
    __mockClient.$queryRawUnsafe.mockResolvedValue([{ '1': 1 }]);
  });

  describe('constructor', () => {
    it('throws if DATABASE_URL is not set', () => {
      expect(() => new PrismaService(makeConfigService(undefined))).toThrow(
        'DATABASE_URL is not set',
      );
    });

    it('creates service with SQLite URL (file: prefix)', () => {
      const { PrismaLibSql } = jest.requireMock('@prisma/adapter-libsql');
      const service = new PrismaService(
        makeConfigService('file:~/.dokkimi/dokkimi.db'),
      );
      expect(service).toBeDefined();
      expect(PrismaLibSql).toHaveBeenCalledWith({
        url: 'file:~/.dokkimi/dokkimi.db',
      });
    });

    it('creates service with PostgreSQL URL', () => {
      const { PrismaPg } = jest.requireMock('@prisma/adapter-pg');
      const service = new PrismaService(
        makeConfigService('postgres://localhost:5432/dokkimi'),
      );
      expect(service).toBeDefined();
      expect(PrismaPg).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            connectionString: 'postgres://localhost:5432/dokkimi',
          }),
        }),
      );
    });
  });

  describe('model accessors', () => {
    it('exposes all model accessors', () => {
      const service = new PrismaService(makeConfigService('file:test.db'));
      expect(service.client).toBeDefined();
      expect(service.namespaceInstance).toBeDefined();
      expect(service.instanceItem).toBeDefined();
      expect(service.httpLog).toBeDefined();
      expect(service.consoleLog).toBeDefined();
      expect(service.databaseLog).toBeDefined();
      expect(service.testExecutionLog).toBeDefined();
      expect(service.assertionResult).toBeDefined();
      expect(service.artifact).toBeDefined();
      expect(service.run).toBeDefined();
    });
  });

  describe('onModuleInit', () => {
    it('connects and verifies schema', async () => {
      const service = new PrismaService(makeConfigService('file:test.db'));

      await service.onModuleInit();

      expect(__mockClient.$connect).toHaveBeenCalled();
      expect(__mockClient.$queryRawUnsafe).toHaveBeenCalledWith(
        'SELECT 1 FROM _prisma_migrations LIMIT 1',
      );
    });
  });

  describe('connectWithRetry', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('retries on connection failure', async () => {
      __mockClient.$connect
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(undefined);

      const service = new PrismaService(makeConfigService('file:test.db'));

      const initPromise = service.onModuleInit();
      await jest.advanceTimersByTimeAsync(2000);
      await jest.advanceTimersByTimeAsync(2000);
      await initPromise;

      expect(__mockClient.$connect).toHaveBeenCalledTimes(3);
    });

    it('throws after max attempts exhausted', async () => {
      __mockClient.$connect.mockRejectedValue(new Error('ECONNREFUSED'));

      const service = new PrismaService(makeConfigService('file:test.db'));

      const initPromise = service.onModuleInit().catch((e: Error) => e);
      for (let i = 0; i < 9; i++) {
        await jest.advanceTimersByTimeAsync(2000);
      }
      const err = await initPromise;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('ECONNREFUSED');
    });
  });

  describe('verifySchema', () => {
    it('throws descriptive error when migrations table missing (SQLite)', async () => {
      __mockClient.$queryRawUnsafe
        .mockResolvedValueOnce([{ '1': 1 }])
        .mockRejectedValue(
          new Error('no such table: _prisma_migrations'),
        );

      const service = new PrismaService(makeConfigService('file:test.db'));

      await expect(service.onModuleInit()).rejects.toThrow(
        'Dokkimi database schema is not initialized',
      );
    });

    it('throws descriptive error when migrations table missing (PostgreSQL)', async () => {
      __mockClient.$queryRawUnsafe
        .mockResolvedValueOnce([{ '1': 1 }])
        .mockRejectedValue(
          new Error('relation "_prisma_migrations" does not exist'),
        );

      const service = new PrismaService(
        makeConfigService('postgres://localhost/db'),
      );

      await expect(service.onModuleInit()).rejects.toThrow(
        'Dokkimi database schema is not initialized',
      );
    });

    it('re-throws non-schema errors', async () => {
      __mockClient.$queryRawUnsafe
        .mockResolvedValueOnce([{ '1': 1 }])
        .mockRejectedValue(
          new Error('permission denied'),
        );

      const service = new PrismaService(makeConfigService('file:test.db'));

      await expect(service.onModuleInit()).rejects.toThrow('permission denied');
    });
  });

  describe('onModuleDestroy', () => {
    it('disconnects', async () => {
      const service = new PrismaService(makeConfigService('file:test.db'));

      await service.onModuleDestroy();

      expect(__mockClient.$disconnect).toHaveBeenCalled();
    });
  });

  describe('$queryRaw', () => {
    it('delegates to prisma.$queryRaw', () => {
      const service = new PrismaService(makeConfigService('file:test.db'));

      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      service.$queryRaw`SELECT 1`;

      expect(__mockClient.$queryRaw).toHaveBeenCalled();
    });
  });
});
