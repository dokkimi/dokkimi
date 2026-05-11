import { Test, TestingModule } from '@nestjs/testing';
import { TestExecutionLogProcessorService } from './test-execution-log-processor.service';
import { StorageService } from '../storage.service';
import { NamespaceValidationService } from '../namespace-validation/namespace-validation.service';
import { TestExecutionLogMessageDto } from '../dto/test-execution-log-message.dto';

describe('TestExecutionLogProcessorService', () => {
  let service: TestExecutionLogProcessorService;
  let storageService: jest.Mocked<StorageService>;
  let namespaceValidationService: jest.Mocked<NamespaceValidationService>;

  beforeEach(async () => {
    const mockStorageService = {
      storeTestExecutionLog: jest.fn(),
    };

    const mockNamespaceValidationService = {
      validateInstance: jest.fn(),
      clearCache: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TestExecutionLogProcessorService,
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

    service = module.get<TestExecutionLogProcessorService>(
      TestExecutionLogProcessorService,
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
    const validMessage: TestExecutionLogMessageDto = {
      instanceId: 'instance-123',
      eventType: 'STARTED',
      message: 'Starting test-agent...',
    };

    it('should process valid test execution log message', async () => {
      const instanceId = 'instance-123';
      const logId = 'log-id-123';

      namespaceValidationService.validateInstance.mockResolvedValue(true);
      storageService.storeTestExecutionLog.mockResolvedValue(logId);

      await service.process(validMessage, instanceId);

      expect(namespaceValidationService.validateInstance).toHaveBeenCalledWith(
        instanceId,
      );
      expect(storageService.storeTestExecutionLog).toHaveBeenCalledWith(
        validMessage,
      );
    });

    it('should process test execution log with all optional fields', async () => {
      const instanceId = 'instance-123';
      const logId = 'log-id-123';
      const fullMessage: TestExecutionLogMessageDto = {
        instanceId: 'instance-123',
        eventType: 'REQUEST_COMPLETED',
        message: 'Request completed',
        stepIndex: 0,
        subActionIndex: 1,
        duration: 45,
        error: 'connection refused',
        errorType: 'network',
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      namespaceValidationService.validateInstance.mockResolvedValue(true);
      storageService.storeTestExecutionLog.mockResolvedValue(logId);

      await service.process(fullMessage, instanceId);

      expect(storageService.storeTestExecutionLog).toHaveBeenCalledWith(
        fullMessage,
      );
    });

    it('should skip processing if instance is invalid', async () => {
      const instanceId = 'invalid-instance';

      namespaceValidationService.validateInstance.mockResolvedValue(false);

      await service.process(validMessage, instanceId);

      expect(namespaceValidationService.validateInstance).toHaveBeenCalledWith(
        instanceId,
      );
      expect(storageService.storeTestExecutionLog).not.toHaveBeenCalled();
    });

    it('should handle storage service errors', async () => {
      const instanceId = 'instance-123';
      const error = new Error('Storage error');

      namespaceValidationService.validateInstance.mockResolvedValue(true);
      storageService.storeTestExecutionLog.mockRejectedValue(error);

      await expect(service.process(validMessage, instanceId)).rejects.toThrow(
        'Storage error',
      );
    });

    it('should process different event types', async () => {
      const instanceId = 'instance-123';
      const logId = 'log-id-123';
      const eventTypes = [
        'STARTED',
        'HEALTH_WAIT_STARTED',
        'HEALTH_ITEM_READY',
        'HEALTH_ALL_READY',
        'TEST_EXECUTION_STARTED',
        'REQUEST_GROUP_STARTED',
        'REQUEST_STARTED',
        'REQUEST_COMPLETED',
        'REQUEST_GROUP_COMPLETED',
        'TEST_EXECUTION_COMPLETED',
        'TVS_NOTIFICATION_SENT',
        'TVS_NOTIFICATION_FAILED',
      ];

      namespaceValidationService.validateInstance.mockResolvedValue(true);
      storageService.storeTestExecutionLog.mockResolvedValue(logId);

      for (const eventType of eventTypes) {
        const message: TestExecutionLogMessageDto = {
          instanceId,
          eventType,
          message: `Test message for ${eventType}`,
        };

        await service.process(message, instanceId);

        expect(storageService.storeTestExecutionLog).toHaveBeenCalledWith(
          message,
        );
      }

      expect(storageService.storeTestExecutionLog).toHaveBeenCalledTimes(
        eventTypes.length,
      );
    });
  });
});
