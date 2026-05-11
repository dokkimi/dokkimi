import { Test, TestingModule } from '@nestjs/testing';
import { StorageService } from './storage.service';
import { PrismaService } from '../prisma/prisma.service';

describe('StorageService', () => {
  let service: StorageService;

  const mockPrisma = {
    httpLog: { create: jest.fn() },
    consoleLog: { create: jest.fn() },
    databaseLog: { create: jest.fn() },
    testExecutionLog: { create: jest.fn() },
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get(StorageService);
  });

  describe('storeHttpLog', () => {
    it('should store an HTTP log with all fields and return the id', async () => {
      mockPrisma.httpLog.create.mockResolvedValue({ id: 'http-1' });

      const result = await service.storeHttpLog({
        instanceId: 'inst-1',
        instanceItemId: 'item-1',
        method: 'GET',
        url: '/api/test',
        statusCode: 200,
        requestBody: { key: 'value' },
        responseBody: { result: 'ok' },
        requestHeaders: { 'content-type': 'application/json' },
        responseHeaders: { 'x-request-id': '123' },
        isMocked: false,
        timestamp: '2026-01-01T00:00:00Z',
        origin: 'svc-a',
        target: 'svc-b',
        targetId: 'target-1',
        requestSentAt: '2026-01-01T00:00:00Z',
        responseReceivedAt: '2026-01-01T00:00:01Z',
      });

      expect(result).toBe('http-1');
      expect(mockPrisma.httpLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          instanceId: 'inst-1',
          method: 'GET',
          url: '/api/test',
          statusCode: 200,
          origin: 'svc-a',
          target: 'svc-b',
        }),
      });
    });

    it('should normalize string timestamps to Date objects', async () => {
      mockPrisma.httpLog.create.mockResolvedValue({ id: 'http-2' });

      await service.storeHttpLog({
        instanceId: 'inst-1',
        method: 'POST',
        url: '/test',
        timestamp: '2026-06-15T12:00:00Z',
        requestSentAt: '2026-06-15T12:00:00Z',
        responseReceivedAt: '2026-06-15T12:00:01Z',
      });

      const data = mockPrisma.httpLog.create.mock.calls[0][0].data;
      expect(data.timestamp).toBeInstanceOf(Date);
      expect(data.requestSentAt).toBeInstanceOf(Date);
      expect(data.responseReceivedAt).toBeInstanceOf(Date);
    });

    it('should default timestamp to now when not provided', async () => {
      mockPrisma.httpLog.create.mockResolvedValue({ id: 'http-3' });

      await service.storeHttpLog({
        instanceId: 'inst-1',
        method: 'GET',
        url: '/test',
      });

      const data = mockPrisma.httpLog.create.mock.calls[0][0].data;
      expect(data.timestamp).toBeInstanceOf(Date);
    });

    it('should set optional fields to null when not provided', async () => {
      mockPrisma.httpLog.create.mockResolvedValue({ id: 'http-4' });

      await service.storeHttpLog({
        instanceId: 'inst-1',
        method: 'GET',
        url: '/test',
      });

      const data = mockPrisma.httpLog.create.mock.calls[0][0].data;
      expect(data.instanceItemId).toBeNull();
      expect(data.statusCode).toBeNull();
      expect(data.isMocked).toBeNull();
      expect(data.origin).toBeNull();
      expect(data.target).toBeNull();
      expect(data.requestSentAt).toBeNull();
      expect(data.responseReceivedAt).toBeNull();
    });

    it('should re-throw Prisma errors', async () => {
      mockPrisma.httpLog.create.mockRejectedValue(new Error('db error'));

      await expect(
        service.storeHttpLog({
          instanceId: 'inst-1',
          method: 'GET',
          url: '/test',
        }),
      ).rejects.toThrow('db error');
    });
  });

  describe('storeConsoleLog', () => {
    it('should store a console log and return the id', async () => {
      mockPrisma.consoleLog.create.mockResolvedValue({ id: 'console-1' });

      const result = await service.storeConsoleLog({
        instanceId: 'inst-1',
        instanceItemId: 'item-1',
        level: 'INFO',
        message: 'Hello world',
        timestamp: '2026-01-01T00:00:00Z',
      });

      expect(result).toBe('console-1');
      expect(mockPrisma.consoleLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          instanceId: 'inst-1',
          level: 'INFO',
          message: 'Hello world',
        }),
      });
    });

    it('should normalize timestamp to Date', async () => {
      mockPrisma.consoleLog.create.mockResolvedValue({ id: 'c-2' });

      await service.storeConsoleLog({
        instanceId: 'inst-1',
        level: 'ERROR',
        message: 'fail',
        timestamp: '2026-01-01T00:00:00Z',
      });

      const data = mockPrisma.consoleLog.create.mock.calls[0][0].data;
      expect(data.timestamp).toBeInstanceOf(Date);
    });

    it('should set instanceItemId to null when not provided', async () => {
      mockPrisma.consoleLog.create.mockResolvedValue({ id: 'c-3' });

      await service.storeConsoleLog({
        instanceId: 'inst-1',
        level: 'INFO',
        message: 'test',
      });

      const data = mockPrisma.consoleLog.create.mock.calls[0][0].data;
      expect(data.instanceItemId).toBeNull();
    });
  });

  describe('storeDatabaseLog', () => {
    it('should store a database log and return the id', async () => {
      mockPrisma.databaseLog.create.mockResolvedValue({ id: 'db-1' });

      const result = await service.storeDatabaseLog({
        instanceId: 'inst-1',
        databaseType: 'postgresql',
        databaseName: 'testdb',
        query: 'SELECT 1',
        success: true,
      });

      expect(result).toBe('db-1');
    });

    it('should normalize "postgres" to "postgresql"', async () => {
      mockPrisma.databaseLog.create.mockResolvedValue({ id: 'db-2' });

      await service.storeDatabaseLog({
        instanceId: 'inst-1',
        databaseType: 'postgres',
        databaseName: 'testdb',
        query: 'SELECT 1',
        success: true,
      });

      const data = mockPrisma.databaseLog.create.mock.calls[0][0].data;
      expect(data.databaseType).toBe('postgresql');
    });

    it('should normalize "mariadb" to "mysql"', async () => {
      mockPrisma.databaseLog.create.mockResolvedValue({ id: 'db-3' });

      await service.storeDatabaseLog({
        instanceId: 'inst-1',
        databaseType: 'mariadb',
        databaseName: 'testdb',
        query: 'SELECT 1',
        success: true,
      });

      const data = mockPrisma.databaseLog.create.mock.calls[0][0].data;
      expect(data.databaseType).toBe('mysql');
    });

    it('should normalize databaseType to lowercase', async () => {
      mockPrisma.databaseLog.create.mockResolvedValue({ id: 'db-4' });

      await service.storeDatabaseLog({
        instanceId: 'inst-1',
        databaseType: 'PostgreSQL',
        databaseName: 'testdb',
        query: 'SELECT 1',
        success: true,
      });

      const data = mockPrisma.databaseLog.create.mock.calls[0][0].data;
      expect(data.databaseType).toBe('postgresql');
    });

    it('should serialize non-null data as InputJsonValue', async () => {
      mockPrisma.databaseLog.create.mockResolvedValue({ id: 'db-5' });

      const dataPayload = [{ id: 1, name: 'test' }];
      await service.storeDatabaseLog({
        instanceId: 'inst-1',
        databaseType: 'postgresql',
        databaseName: 'testdb',
        query: 'SELECT * FROM users',
        success: true,
        data: dataPayload,
      });

      const data = mockPrisma.databaseLog.create.mock.calls[0][0].data;
      expect(data.data).toEqual(dataPayload);
    });

    it('should leave data as undefined when null or undefined', async () => {
      mockPrisma.databaseLog.create.mockResolvedValue({ id: 'db-6' });

      await service.storeDatabaseLog({
        instanceId: 'inst-1',
        databaseType: 'postgresql',
        databaseName: 'testdb',
        query: 'DELETE FROM users',
        success: true,
        data: null as any,
      });

      const data = mockPrisma.databaseLog.create.mock.calls[0][0].data;
      expect(data.data).toBeUndefined();
    });

    it('should set optional fields to null when not provided', async () => {
      mockPrisma.databaseLog.create.mockResolvedValue({ id: 'db-7' });

      await service.storeDatabaseLog({
        instanceId: 'inst-1',
        databaseType: 'postgresql',
        databaseName: 'testdb',
        query: 'SELECT 1',
        success: true,
      });

      const data = mockPrisma.databaseLog.create.mock.calls[0][0].data;
      expect(data.rowsAffected).toBeNull();
      expect(data.error).toBeNull();
      expect(data.duration).toBeNull();
    });
  });

  describe('storeTestExecutionLog', () => {
    it('should store a test execution log and return the id', async () => {
      mockPrisma.testExecutionLog.create.mockResolvedValue({ id: 'te-1' });

      const result = await service.storeTestExecutionLog({
        instanceId: 'inst-1',
        eventType: 'TEST_STARTED',
        message: 'Test started',
      });

      expect(result).toBe('te-1');
    });

    it('should default variables to empty object when not provided', async () => {
      mockPrisma.testExecutionLog.create.mockResolvedValue({ id: 'te-2' });

      await service.storeTestExecutionLog({
        instanceId: 'inst-1',
        eventType: 'TEST_STARTED',
        message: 'Test started',
      });

      const data = mockPrisma.testExecutionLog.create.mock.calls[0][0].data;
      expect(data.variables).toEqual({});
    });

    it('should store provided variables', async () => {
      mockPrisma.testExecutionLog.create.mockResolvedValue({ id: 'te-3' });

      const vars = { userId: '123', token: 'abc' };
      await service.storeTestExecutionLog({
        instanceId: 'inst-1',
        eventType: 'REQUEST_COMPLETED',
        message: 'Request done',
        variables: vars,
      });

      const data = mockPrisma.testExecutionLog.create.mock.calls[0][0].data;
      expect(data.variables).toEqual(vars);
    });

    it('should set optional fields to null when not provided', async () => {
      mockPrisma.testExecutionLog.create.mockResolvedValue({ id: 'te-4' });

      await service.storeTestExecutionLog({
        instanceId: 'inst-1',
        eventType: 'TEST_STARTED',
        message: 'Test started',
      });

      const data = mockPrisma.testExecutionLog.create.mock.calls[0][0].data;
      expect(data.stepIndex).toBeNull();
      expect(data.subActionIndex).toBeNull();
      expect(data.subStepIndex).toBeNull();
      expect(data.actionType).toBeNull();
      expect(data.selector).toBeNull();
      expect(data.duration).toBeNull();
      expect(data.error).toBeNull();
      expect(data.errorType).toBeNull();
    });

    it('should store all optional fields when provided', async () => {
      mockPrisma.testExecutionLog.create.mockResolvedValue({ id: 'te-5' });

      await service.storeTestExecutionLog({
        instanceId: 'inst-1',
        eventType: 'UI_SUBSTEP_COMPLETED',
        message: 'Clicked button',
        stepIndex: 0,
        subActionIndex: 1,
        subStepIndex: 2,
        actionType: 'click',
        selector: '#submit-btn',
        duration: 150,
        timestamp: '2026-01-01T00:00:00Z',
      });

      const data = mockPrisma.testExecutionLog.create.mock.calls[0][0].data;
      expect(data.stepIndex).toBe(0);
      expect(data.subActionIndex).toBe(1);
      expect(data.subStepIndex).toBe(2);
      expect(data.actionType).toBe('click');
      expect(data.selector).toBe('#submit-btn');
      expect(data.duration).toBe(150);
      expect(data.timestamp).toBeInstanceOf(Date);
    });
  });
});
