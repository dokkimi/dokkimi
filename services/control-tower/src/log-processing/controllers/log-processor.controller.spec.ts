import { LogProcessorController } from './log-processor.controller';

describe('LogProcessorController', () => {
  let controller: LogProcessorController;

  const mockHttpLogProcessor: any = {
    process: jest.fn().mockResolvedValue(undefined),
  };

  const mockConsoleLogProcessor: any = {
    processFromFluentBit: jest.fn().mockResolvedValue(undefined),
  };

  const mockDatabaseLogProcessor: any = {
    process: jest.fn().mockResolvedValue(undefined),
  };

  const mockTestExecutionLogProcessor: any = {
    process: jest.fn().mockResolvedValue(undefined),
  };

  const mockTelemetry: any = {
    track: jest.fn(),
  };

  beforeEach(() => {
    controller = new LogProcessorController(
      mockHttpLogProcessor,
      mockConsoleLogProcessor,
      mockDatabaseLogProcessor,
      mockTestExecutionLogProcessor,
      mockTelemetry,
    );
    jest.clearAllMocks();
  });

  describe('receiveHttpLog', () => {
    it('processes via httpLogProcessor and returns received', async () => {
      const message = { instanceId: 'inst-1', method: 'GET', url: '/api' };

      const result = await controller.receiveHttpLog(message as any);

      expect(mockHttpLogProcessor.process).toHaveBeenCalledWith(
        message,
        'inst-1',
      );
      expect(result).toEqual({ received: true });
    });
  });

  describe('receiveConsoleLog', () => {
    it('processes single message via consoleLogProcessor', async () => {
      const message = { log: 'hello', instanceId: 'inst-1' };

      const result = await controller.receiveConsoleLog(message as any);

      expect(mockConsoleLogProcessor.processFromFluentBit).toHaveBeenCalledWith(
        message,
      );
      expect(result).toEqual({ received: true });
    });

    it('processes array of messages', async () => {
      const messages = [
        { log: 'line1', instanceId: 'inst-1' },
        { log: 'line2', instanceId: 'inst-1' },
      ];

      const result = await controller.receiveConsoleLog(messages as any);

      expect(mockConsoleLogProcessor.processFromFluentBit).toHaveBeenCalledWith(
        messages,
      );
      expect(result).toEqual({ received: true });
    });
  });

  describe('receiveDatabaseLog', () => {
    it('processes database log and returns received', async () => {
      const body = {
        instanceId: 'inst-1',
        instanceItemId: 'item-1',
        databaseType: 'postgres',
        databaseName: 'users',
        query: 'SELECT 1',
        success: true,
        duration: 5,
        timestamp: '2026-01-01T00:00:00Z',
      };

      const result = await controller.receiveDatabaseLog(body);

      expect(mockDatabaseLogProcessor.process).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: 'inst-1',
          databaseType: 'postgres',
          query: 'SELECT 1',
        }),
        'inst-1',
      );
      expect(result).toEqual({ received: true });
    });

    it('passes all fields to processor', async () => {
      const body = {
        instanceId: 'inst-1',
        instanceItemId: 'item-1',
        databaseType: 'postgres',
        databaseName: 'db',
        query: 'INSERT',
        params: ['a', 'b'],
        success: false,
        data: null,
        rowsAffected: 0,
        error: 'constraint violation',
        duration: 12,
        timestamp: '2026-01-01T00:00:00Z',
      };

      await controller.receiveDatabaseLog(body);

      const call = mockDatabaseLogProcessor.process.mock.calls[0][0];
      expect(call.params).toEqual(['a', 'b']);
      expect(call.error).toBe('constraint violation');
      expect(call.rowsAffected).toBe(0);
    });
  });

  describe('receiveTestExecutionLog', () => {
    it('processes test execution log and returns received', async () => {
      const message = {
        instanceId: 'inst-1',
        eventType: 'TEST_STARTED',
        message: 'Running test',
      };

      const result = await controller.receiveTestExecutionLog(message as any);

      expect(mockTestExecutionLogProcessor.process).toHaveBeenCalledWith(
        message,
        'inst-1',
      );
      expect(result).toEqual({ received: true });
    });
  });

  describe('lifecycle and telemetry batching', () => {
    it('onModuleInit sets up batch timer', () => {
      jest.useFakeTimers();
      controller.onModuleInit();

      expect(() => jest.advanceTimersByTime(30000)).not.toThrow();

      controller.onModuleDestroy();
      jest.useRealTimers();
    });

    it('onModuleDestroy clears timer and flushes', async () => {
      jest.useFakeTimers();
      controller.onModuleInit();

      await controller.receiveHttpLog({ instanceId: 'inst-1' } as any);
      controller.onModuleDestroy();

      expect(mockTelemetry.track).toHaveBeenCalledWith(
        'lps_logs_batch',
        expect.objectContaining({
          http_log_count: 1,
          console_log_count: 0,
          database_log_count: 0,
          test_execution_log_count: 0,
        }),
      );
      jest.useRealTimers();
    });

    it('flushBatchTelemetry skips when no logs received', () => {
      controller.onModuleDestroy();

      expect(mockTelemetry.track).not.toHaveBeenCalled();
    });

    it('counts log types correctly across multiple calls', async () => {
      await controller.receiveHttpLog({ instanceId: 'inst-1' } as any);
      await controller.receiveHttpLog({ instanceId: 'inst-1' } as any);
      await controller.receiveConsoleLog({
        log: 'x',
        instanceId: 'inst-1',
      } as any);
      await controller.receiveDatabaseLog({
        instanceId: 'inst-1',
        databaseType: 'pg',
        query: 'q',
      });
      await controller.receiveTestExecutionLog({
        instanceId: 'inst-1',
        eventType: 'E',
      } as any);

      controller.onModuleDestroy();

      expect(mockTelemetry.track).toHaveBeenCalledWith(
        'lps_logs_batch',
        expect.objectContaining({
          http_log_count: 2,
          console_log_count: 1,
          database_log_count: 1,
          test_execution_log_count: 1,
        }),
      );
    });

    it('counts array console log messages correctly', async () => {
      const messages = [
        { log: 'a', instanceId: 'inst-1' },
        { log: 'b', instanceId: 'inst-1' },
        { log: 'c', instanceId: 'inst-1' },
      ];
      await controller.receiveConsoleLog(messages as any);

      controller.onModuleDestroy();

      expect(mockTelemetry.track).toHaveBeenCalledWith(
        'lps_logs_batch',
        expect.objectContaining({
          console_log_count: 3,
        }),
      );
    });

    it('resets counters after flush', async () => {
      jest.useFakeTimers();
      controller.onModuleInit();

      await controller.receiveHttpLog({ instanceId: 'inst-1' } as any);

      jest.advanceTimersByTime(30000);

      expect(mockTelemetry.track).toHaveBeenCalledTimes(1);
      mockTelemetry.track.mockClear();

      jest.advanceTimersByTime(30000);

      expect(mockTelemetry.track).not.toHaveBeenCalled();

      controller.onModuleDestroy();
      jest.useRealTimers();
    });
  });
});
