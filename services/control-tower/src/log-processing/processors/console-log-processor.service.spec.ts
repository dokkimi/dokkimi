import { Test, TestingModule } from '@nestjs/testing';
import { ConsoleLogProcessorService } from './console-log-processor.service';
import { StorageService } from '../storage.service';
import { NamespaceValidationService } from '../namespace-validation/namespace-validation.service';
import { ConsoleLogMessage } from '../../types/messages';
import { FluentBitLogMessageDto } from '../dto/fluentbit-log-message.dto';

describe('ConsoleLogProcessorService', () => {
  let service: ConsoleLogProcessorService;
  let storageService: jest.Mocked<StorageService>;
  let namespaceValidationService: jest.Mocked<NamespaceValidationService>;

  beforeEach(async () => {
    const mockStorageService = {
      storeConsoleLog: jest.fn(),
    };

    const mockNamespaceValidationService = {
      validateInstance: jest.fn(),
      clearCache: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConsoleLogProcessorService,
        {
          provide: StorageService,
          useValue: mockStorageService,
        },
        {
          provide: NamespaceValidationService,
          useValue: mockNamespaceValidationService,
        },
      ],
    }).compile();

    service = module.get<ConsoleLogProcessorService>(
      ConsoleLogProcessorService,
    );
    storageService = module.get(StorageService);
    namespaceValidationService = module.get(NamespaceValidationService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('process', () => {
    const instanceId = 'test-instance';
    const message: ConsoleLogMessage = {
      instanceId,
      level: 'INFO',
      message: 'Service started',
    };

    it('should process and store console log for valid namespace', async () => {
      namespaceValidationService.validateInstance.mockResolvedValue(true);
      storageService.storeConsoleLog.mockResolvedValue('log-id-123');

      await service.process(message, instanceId);

      expect(namespaceValidationService.validateInstance).toHaveBeenCalledWith(
        instanceId,
      );
      expect(storageService.storeConsoleLog).toHaveBeenCalledWith(message);
    });

    it('should skip processing for invalid namespace', async () => {
      namespaceValidationService.validateInstance.mockResolvedValue(false);

      await service.process(message, instanceId);

      expect(namespaceValidationService.validateInstance).toHaveBeenCalledWith(
        instanceId,
      );
      expect(storageService.storeConsoleLog).not.toHaveBeenCalled();
    });

    it('should handle console log with all fields', async () => {
      const fullMessage: ConsoleLogMessage = {
        instanceId,
        instanceItemId: 'service-id',
        level: 'ERROR',
        message: 'Error occurred',
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      namespaceValidationService.validateInstance.mockResolvedValue(true);
      storageService.storeConsoleLog.mockResolvedValue('log-id-456');

      await service.process(fullMessage, instanceId);

      expect(storageService.storeConsoleLog).toHaveBeenCalledWith(fullMessage);
    });

    it('should throw error on storage failure', async () => {
      namespaceValidationService.validateInstance.mockResolvedValue(true);
      storageService.storeConsoleLog.mockRejectedValue(
        new Error('Database error'),
      );

      await expect(service.process(message, instanceId)).rejects.toThrow(
        'Database error',
      );

      expect(storageService.storeConsoleLog).toHaveBeenCalled();
    });
  });

  describe('processFromFluentBit', () => {
    const instanceId = 'test-instance';

    it('should process single Fluent Bit message', async () => {
      const message: FluentBitLogMessageDto = {
        instanceId,
        log: '2025-11-27T17:50:38.989944416Z stdout F [INFO] Service started',
        stream: 'stdout',
        time: '2025-11-27T17:50:38.989944416Z',
      };

      namespaceValidationService.validateInstance.mockResolvedValue(true);
      storageService.storeConsoleLog.mockResolvedValue('log-id-123');

      await service.processFromFluentBit(message);

      expect(namespaceValidationService.validateInstance).toHaveBeenCalledWith(
        instanceId,
      );
      expect(storageService.storeConsoleLog).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId,
          level: 'INFO',
          message: '[INFO] Service started',
        }),
      );
    });

    it('should process array of Fluent Bit messages', async () => {
      const messages: FluentBitLogMessageDto[] = [
        {
          instanceId,
          log: '2025-11-27T17:50:38.989944416Z stdout F [INFO] First log',
          stream: 'stdout',
        },
        {
          instanceId,
          log: '2025-11-27T17:50:39.000000000Z stderr F [ERROR] Second log',
          stream: 'stderr',
        },
      ];

      namespaceValidationService.validateInstance.mockResolvedValue(true);
      storageService.storeConsoleLog
        .mockResolvedValueOnce('log-id-1')
        .mockResolvedValueOnce('log-id-2');

      await service.processFromFluentBit(messages);

      expect(storageService.storeConsoleLog).toHaveBeenCalledTimes(2);
      expect(storageService.storeConsoleLog).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          instanceId,
          level: 'INFO',
          message: '[INFO] First log',
        }),
      );
      expect(storageService.storeConsoleLog).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          instanceId,
          level: 'ERROR',
          message: '[ERROR] Second log',
        }),
      );
    });

    it('should skip message without instanceId', async () => {
      const message: FluentBitLogMessageDto = {
        log: '[INFO] Service started',
      } as any;

      await service.processFromFluentBit(message);

      expect(
        namespaceValidationService.validateInstance,
      ).not.toHaveBeenCalled();
      expect(storageService.storeConsoleLog).not.toHaveBeenCalled();
    });

    it('should handle CRI format log line', async () => {
      const message: FluentBitLogMessageDto = {
        instanceId,
        log: '2025-11-27T17:50:38.989944416Z stdout F [WARN] Warning message',
      };

      namespaceValidationService.validateInstance.mockResolvedValue(true);
      storageService.storeConsoleLog.mockResolvedValue('log-id-123');

      await service.processFromFluentBit(message);

      expect(storageService.storeConsoleLog).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId,
          level: 'WARN',
          message: '[WARN] Warning message',
          timestamp: '2025-11-27T17:50:38.989944416Z',
        }),
      );
    });

    it('should handle non-CRI format log line', async () => {
      const message: FluentBitLogMessageDto = {
        instanceId,
        log: '[DEBUG] Simple log message',
        time: '2025-11-27T17:50:38.989944416Z',
      };

      namespaceValidationService.validateInstance.mockResolvedValue(true);
      storageService.storeConsoleLog.mockResolvedValue('log-id-123');

      await service.processFromFluentBit(message);

      expect(storageService.storeConsoleLog).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId,
          level: 'DEBUG',
          message: '[DEBUG] Simple log message',
          timestamp: '2025-11-27T17:50:38.989944416Z',
        }),
      );
    });

    it('should use time from Fluent Bit if CRI timestamp not available', async () => {
      const message: FluentBitLogMessageDto = {
        instanceId,
        log: 'Simple log without CRI format',
        time: '2025-11-27T17:50:38.000Z',
      };

      namespaceValidationService.validateInstance.mockResolvedValue(true);
      storageService.storeConsoleLog.mockResolvedValue('log-id-123');

      await service.processFromFluentBit(message);

      expect(storageService.storeConsoleLog).toHaveBeenCalledWith(
        expect.objectContaining({
          timestamp: '2025-11-27T17:50:38.000Z',
        }),
      );
    });

    it('should parse different log levels correctly', async () => {
      const testCases = [
        { log: '[ERROR] Error message', expectedLevel: 'ERROR' },
        { log: '[WARN] Warning message', expectedLevel: 'WARN' },
        { log: '[DEBUG] Debug message', expectedLevel: 'DEBUG' },
        { log: '[INFO] Info message', expectedLevel: 'INFO' },
        { log: 'ERROR: Something went wrong', expectedLevel: 'ERROR' },
        { log: 'WARN: This is a warning', expectedLevel: 'WARN' },
        { log: 'DEBUG: Debug info', expectedLevel: 'DEBUG' },
        { log: 'INFO: Information', expectedLevel: 'INFO' },
        { log: 'No level prefix', expectedLevel: 'INFO' }, // Default
      ];

      namespaceValidationService.validateInstance.mockResolvedValue(true);
      storageService.storeConsoleLog.mockResolvedValue('log-id');

      for (const testCase of testCases) {
        jest.clearAllMocks();
        const message: FluentBitLogMessageDto = {
          instanceId,
          log: testCase.log,
        };

        await service.processFromFluentBit(message);

        expect(storageService.storeConsoleLog).toHaveBeenCalledWith(
          expect.objectContaining({
            level: testCase.expectedLevel,
          }),
        );
      }
    });

    it('should handle instanceItemId from Fluent Bit', async () => {
      const message: FluentBitLogMessageDto = {
        instanceId,
        instanceItemId: 'service-id-123',
        log: '[INFO] Service heartbeat',
      };

      namespaceValidationService.validateInstance.mockResolvedValue(true);
      storageService.storeConsoleLog.mockResolvedValue('log-id-123');

      await service.processFromFluentBit(message);

      expect(storageService.storeConsoleLog).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId,
          instanceItemId: 'service-id-123',
        }),
      );
    });

    it('should continue processing other messages if one fails', async () => {
      const messages: FluentBitLogMessageDto[] = [
        {
          instanceId,
          log: '[INFO] First log',
        },
        {
          instanceId,
          log: '[ERROR] Second log that will fail',
        },
        {
          instanceId,
          log: '[INFO] Third log',
        },
      ];

      namespaceValidationService.validateInstance.mockResolvedValue(true);
      storageService.storeConsoleLog
        .mockResolvedValueOnce('log-id-1')
        .mockRejectedValueOnce(new Error('Storage error'))
        .mockResolvedValueOnce('log-id-3');

      await service.processFromFluentBit(messages);

      expect(storageService.storeConsoleLog).toHaveBeenCalledTimes(3);
    });

    it('should handle empty log line', async () => {
      const message: FluentBitLogMessageDto = {
        instanceId,
        log: '',
      };

      namespaceValidationService.validateInstance.mockResolvedValue(true);
      storageService.storeConsoleLog.mockResolvedValue('log-id-123');

      await service.processFromFluentBit(message);

      expect(storageService.storeConsoleLog).toHaveBeenCalledWith(
        expect.objectContaining({
          message: '',
          level: 'INFO', // Default level
        }),
      );
    });
  });
});
