import { Test, TestingModule } from '@nestjs/testing';
import { LogQueryService } from './log-query.service';
import { PrismaService } from '../prisma/prisma.service';

describe('LogQueryService', () => {
  let service: LogQueryService;
  let mockPrismaService: {
    httpLog: {
      findMany: jest.Mock;
      count: jest.Mock;
    };
    consoleLog: {
      findMany: jest.Mock;
      count: jest.Mock;
    };
    databaseLog: {
      findMany: jest.Mock;
      count: jest.Mock;
    };
    testExecutionLog: {
      findMany: jest.Mock;
      count: jest.Mock;
    };
    assertionResult: {
      findMany: jest.Mock;
    };
  };

  beforeEach(async () => {
    mockPrismaService = {
      httpLog: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
      consoleLog: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
      databaseLog: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
      testExecutionLog: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
      assertionResult: {
        findMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LogQueryService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<LogQueryService>(LogQueryService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getHttpLogs', () => {
    it('should get HTTP logs without filters', async () => {
      const now = new Date();
      const mockLogs = [
        {
          id: 'log-1',
          instanceId: 'ns-1',
          method: 'GET',
          url: '/api/test',
          statusCode: 200,
          requestSentAt: now,
          responseReceivedAt: new Date(now.getTime() + 50),
        },
        {
          id: 'log-2',
          instanceId: 'ns-2',
          method: 'POST',
          url: '/api/create',
          statusCode: 201,
          requestSentAt: now,
          responseReceivedAt: null,
        },
      ];

      mockPrismaService.httpLog.findMany.mockResolvedValue(mockLogs as any);
      mockPrismaService.httpLog.count.mockResolvedValue(2);

      const result = await service.getHttpLogs();

      expect(result.total).toBe(2);
      expect(result.limit).toBe(100);
      expect(result.offset).toBe(0);
      expect(result.logs[0].duration).toBe(50);
      expect(result.logs[1].duration).toBeNull();
      expect(mockPrismaService.httpLog.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { requestSentAt: 'desc' },
        take: 100,
        skip: 0,
      });
      expect(mockPrismaService.httpLog.count).toHaveBeenCalledWith({
        where: {},
      });
    });

    it('should filter HTTP logs by instanceId', async () => {
      const instanceId = 'ns-1';
      const mockLogs = [
        {
          id: 'log-1',
          instanceId,
          method: 'GET',
          url: '/api/test',
          statusCode: 200,
          requestSentAt: new Date(),
          responseReceivedAt: null,
        },
      ];

      mockPrismaService.httpLog.findMany.mockResolvedValue(mockLogs as any);
      mockPrismaService.httpLog.count.mockResolvedValue(1);

      const result = await service.getHttpLogs(instanceId);

      expect(result.logs).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(mockPrismaService.httpLog.findMany).toHaveBeenCalledWith({
        where: { instanceId },
        orderBy: { requestSentAt: 'desc' },
        take: 100,
        skip: 0,
      });
      expect(mockPrismaService.httpLog.count).toHaveBeenCalledWith({
        where: { instanceId },
      });
    });

    it('should respect limit and offset', async () => {
      const mockLogs = [
        {
          id: 'log-1',
          instanceId: 'ns-1',
          method: 'GET',
          url: '/api/test',
          statusCode: 200,
          requestSentAt: new Date(),
          responseReceivedAt: null,
        },
      ];

      mockPrismaService.httpLog.findMany.mockResolvedValue(mockLogs as any);
      mockPrismaService.httpLog.count.mockResolvedValue(50);

      const result = await service.getHttpLogs(undefined, 10, 20);

      expect(result.limit).toBe(10);
      expect(result.offset).toBe(20);
      expect(mockPrismaService.httpLog.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { requestSentAt: 'desc' },
        take: 10,
        skip: 20,
      });
    });
  });

  describe('getConsoleLogs', () => {
    it('should get console logs without filters', async () => {
      const mockLogs = [
        {
          id: 'log-1',
          instanceId: 'ns-1',
          instanceItemId: 'item-1',
          level: 'INFO',
          message: 'Service started',
          timestamp: new Date(),
        },
      ];

      mockPrismaService.consoleLog.findMany.mockResolvedValue(mockLogs as any);
      mockPrismaService.consoleLog.count.mockResolvedValue(1);

      const result = await service.getConsoleLogs();

      expect(result).toEqual({
        logs: mockLogs,
        total: 1,
        limit: 100,
        offset: 0,
      });
      expect(mockPrismaService.consoleLog.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { timestamp: 'desc' },
        take: 100,
        skip: 0,
      });
      expect(mockPrismaService.consoleLog.count).toHaveBeenCalledWith({
        where: {},
      });
    });

    it('should filter console logs by instanceId', async () => {
      const instanceId = 'ns-1';
      const mockLogs = [
        {
          id: 'log-1',
          instanceId,
          instanceItemId: null,
          level: 'ERROR',
          message: 'Error occurred',
          timestamp: new Date(),
        },
      ];

      mockPrismaService.consoleLog.findMany.mockResolvedValue(mockLogs as any);
      mockPrismaService.consoleLog.count.mockResolvedValue(1);

      const result = await service.getConsoleLogs(instanceId);

      expect(result.logs).toEqual(mockLogs);
      expect(mockPrismaService.consoleLog.findMany).toHaveBeenCalledWith({
        where: { instanceId },
        orderBy: { timestamp: 'desc' },
        take: 100,
        skip: 0,
      });
    });

    it('should filter console logs by instanceItemId', async () => {
      const instanceItemId = 'item-1';
      const mockLogs = [
        {
          id: 'log-1',
          instanceId: 'ns-1',
          instanceItemId,
          level: 'INFO',
          message: 'Service started',
          timestamp: new Date(),
        },
      ];

      mockPrismaService.consoleLog.findMany.mockResolvedValue(mockLogs as any);
      mockPrismaService.consoleLog.count.mockResolvedValue(1);

      const result = await service.getConsoleLogs(undefined, instanceItemId);

      expect(result.logs).toEqual(mockLogs);
      expect(mockPrismaService.consoleLog.findMany).toHaveBeenCalledWith({
        where: { instanceItemId },
        orderBy: { timestamp: 'desc' },
        take: 100,
        skip: 0,
      });
    });

    it('should filter console logs by both instanceId and instanceItemId', async () => {
      const instanceId = 'ns-1';
      const instanceItemId = 'item-1';
      const mockLogs = [
        {
          id: 'log-1',
          instanceId,
          instanceItemId,
          level: 'WARN',
          message: 'Warning message',
          timestamp: new Date(),
        },
      ];

      mockPrismaService.consoleLog.findMany.mockResolvedValue(mockLogs as any);
      mockPrismaService.consoleLog.count.mockResolvedValue(1);

      const result = await service.getConsoleLogs(instanceId, instanceItemId);

      expect(result.logs).toEqual(mockLogs);
      expect(mockPrismaService.consoleLog.findMany).toHaveBeenCalledWith({
        where: { instanceId, instanceItemId },
        orderBy: { timestamp: 'desc' },
        take: 100,
        skip: 0,
      });
    });

    it('should respect limit and offset', async () => {
      const mockLogs = [
        {
          id: 'log-1',
          instanceId: 'ns-1',
          instanceItemId: null,
          level: 'INFO',
          message: 'Test',
          timestamp: new Date(),
        },
      ];

      mockPrismaService.consoleLog.findMany.mockResolvedValue(mockLogs as any);
      mockPrismaService.consoleLog.count.mockResolvedValue(50);

      const result = await service.getConsoleLogs(undefined, undefined, 10, 20);

      expect(result.limit).toBe(10);
      expect(result.offset).toBe(20);
      expect(mockPrismaService.consoleLog.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { timestamp: 'desc' },
        take: 10,
        skip: 20,
      });
    });
  });

  describe('getHttpLogs - additional edge cases', () => {
    it('should return null duration when requestSentAt is null', async () => {
      const mockLogs = [
        {
          id: 'log-1',
          instanceId: 'ns-1',
          method: 'GET',
          url: '/api/test',
          statusCode: 200,
          requestSentAt: null,
          responseReceivedAt: new Date(),
        },
      ];

      mockPrismaService.httpLog.findMany.mockResolvedValue(mockLogs as any);
      mockPrismaService.httpLog.count.mockResolvedValue(1);

      const result = await service.getHttpLogs();

      expect(result.logs[0].duration).toBeNull();
    });

    it('should return empty logs array when no logs exist', async () => {
      mockPrismaService.httpLog.findMany.mockResolvedValue([]);
      mockPrismaService.httpLog.count.mockResolvedValue(0);

      const result = await service.getHttpLogs('non-existent');

      expect(result.logs).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.limit).toBe(100);
      expect(result.offset).toBe(0);
    });

    it('should compute duration correctly for large time differences', async () => {
      const sentAt = new Date('2026-01-01T00:00:00.000Z');
      const receivedAt = new Date('2026-01-01T00:01:00.000Z'); // 60 seconds later
      const mockLogs = [
        {
          id: 'log-1',
          instanceId: 'ns-1',
          method: 'GET',
          url: '/api/slow',
          statusCode: 200,
          requestSentAt: sentAt,
          responseReceivedAt: receivedAt,
        },
      ];

      mockPrismaService.httpLog.findMany.mockResolvedValue(mockLogs as any);
      mockPrismaService.httpLog.count.mockResolvedValue(1);

      const result = await service.getHttpLogs();

      expect(result.logs[0].duration).toBe(60000);
    });
  });

  describe('getDatabaseLogs', () => {
    it('should get database logs without filters using default limit of 500', async () => {
      const mockLogs = [
        {
          id: 'db-log-1',
          instanceId: 'ns-1',
          query: 'SELECT * FROM users',
          timestamp: new Date(),
        },
      ];

      mockPrismaService.databaseLog.findMany.mockResolvedValue(mockLogs as any);
      mockPrismaService.databaseLog.count.mockResolvedValue(1);

      const result = await service.getDatabaseLogs();

      expect(result).toEqual({
        logs: mockLogs,
        total: 1,
        limit: 500,
        offset: 0,
      });
      expect(mockPrismaService.databaseLog.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { timestamp: 'desc' },
        take: 500,
        skip: 0,
      });
      expect(mockPrismaService.databaseLog.count).toHaveBeenCalledWith({
        where: {},
      });
    });

    it('should filter database logs by instanceId', async () => {
      const instanceId = 'ns-1';
      const mockLogs = [
        {
          id: 'db-log-1',
          instanceId,
          query: 'INSERT INTO orders',
          timestamp: new Date(),
        },
      ];

      mockPrismaService.databaseLog.findMany.mockResolvedValue(mockLogs as any);
      mockPrismaService.databaseLog.count.mockResolvedValue(1);

      const result = await service.getDatabaseLogs(instanceId);

      expect(result.logs).toEqual(mockLogs);
      expect(mockPrismaService.databaseLog.findMany).toHaveBeenCalledWith({
        where: { instanceId },
        orderBy: { timestamp: 'desc' },
        take: 500,
        skip: 0,
      });
    });

    it('should respect custom limit and offset', async () => {
      mockPrismaService.databaseLog.findMany.mockResolvedValue([]);
      mockPrismaService.databaseLog.count.mockResolvedValue(200);

      const result = await service.getDatabaseLogs(undefined, 25, 50);

      expect(result.limit).toBe(25);
      expect(result.offset).toBe(50);
      expect(mockPrismaService.databaseLog.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { timestamp: 'desc' },
        take: 25,
        skip: 50,
      });
    });
  });

  describe('getTestExecutionLogs', () => {
    it('should get test execution logs without filters using default limit of 1000', async () => {
      const mockLogs = [
        {
          id: 'exec-1',
          instanceId: 'ns-1',
          stepName: 'step-1',
          status: 'PASSED',
          timestamp: new Date(),
        },
      ];

      mockPrismaService.testExecutionLog.findMany.mockResolvedValue(
        mockLogs as any,
      );
      mockPrismaService.testExecutionLog.count.mockResolvedValue(1);

      const result = await service.getTestExecutionLogs();

      expect(result).toEqual({
        logs: mockLogs,
        total: 1,
        limit: 1000,
        offset: 0,
      });
      // Test execution logs use ascending order (chronological timeline)
      expect(mockPrismaService.testExecutionLog.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { timestamp: 'asc' },
        take: 1000,
        skip: 0,
      });
    });

    it('should filter test execution logs by instanceId', async () => {
      const instanceId = 'ns-1';
      const mockLogs = [
        {
          id: 'exec-1',
          instanceId,
          stepName: 'login',
          status: 'PASSED',
          timestamp: new Date(),
        },
        {
          id: 'exec-2',
          instanceId,
          stepName: 'checkout',
          status: 'FAILED',
          timestamp: new Date(),
        },
      ];

      mockPrismaService.testExecutionLog.findMany.mockResolvedValue(
        mockLogs as any,
      );
      mockPrismaService.testExecutionLog.count.mockResolvedValue(2);

      const result = await service.getTestExecutionLogs(instanceId);

      expect(result.logs).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(mockPrismaService.testExecutionLog.findMany).toHaveBeenCalledWith({
        where: { instanceId },
        orderBy: { timestamp: 'asc' },
        take: 1000,
        skip: 0,
      });
    });

    it('should respect custom limit and offset', async () => {
      mockPrismaService.testExecutionLog.findMany.mockResolvedValue([]);
      mockPrismaService.testExecutionLog.count.mockResolvedValue(5000);

      const result = await service.getTestExecutionLogs(undefined, 50, 100);

      expect(result.limit).toBe(50);
      expect(result.offset).toBe(100);
      expect(mockPrismaService.testExecutionLog.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { timestamp: 'asc' },
        take: 50,
        skip: 100,
      });
    });
  });

  describe('getAssertionResults', () => {
    it('should get assertion results for a specific instance', async () => {
      const instanceId = 'ns-1';
      const mockResults = [
        {
          id: 'assert-1',
          instanceId,
          assertionName: 'status is 200',
          passed: true,
          timestamp: new Date(),
        },
        {
          id: 'assert-2',
          instanceId,
          assertionName: 'body contains user',
          passed: false,
          timestamp: new Date(),
        },
      ];

      mockPrismaService.assertionResult.findMany.mockResolvedValue(
        mockResults as any,
      );

      const result = await service.getAssertionResults(instanceId);

      expect(result).toEqual(mockResults);
      expect(mockPrismaService.assertionResult.findMany).toHaveBeenCalledWith({
        where: { instanceId },
        orderBy: { timestamp: 'asc' },
      });
    });

    it('should return empty array when no assertion results exist', async () => {
      mockPrismaService.assertionResult.findMany.mockResolvedValue([]);

      const result = await service.getAssertionResults('non-existent');

      expect(result).toEqual([]);
      expect(mockPrismaService.assertionResult.findMany).toHaveBeenCalledWith({
        where: { instanceId: 'non-existent' },
        orderBy: { timestamp: 'asc' },
      });
    });
  });
});
