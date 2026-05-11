import { Test, TestingModule } from '@nestjs/testing';
import { HttpLogProcessorService } from './http-log-processor.service';
import { StorageService } from '../storage.service';
import { NamespaceValidationService } from '../namespace-validation/namespace-validation.service';
import { HttpLogMessage } from '../../types/messages';

describe('HttpLogProcessorService', () => {
  let service: HttpLogProcessorService;
  let storageService: jest.Mocked<StorageService>;
  let namespaceValidationService: jest.Mocked<NamespaceValidationService>;

  beforeEach(async () => {
    const mockStorageService = {
      storeHttpLog: jest.fn(),
    };

    const mockNamespaceValidationService = {
      validateInstance: jest.fn(),
      clearCache: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HttpLogProcessorService,
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

    service = module.get<HttpLogProcessorService>(HttpLogProcessorService);
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
    const message: HttpLogMessage = {
      instanceId,
      method: 'GET',
      url: '/api/test',
      statusCode: 200,
    };

    it('should process and store HTTP log for valid namespace', async () => {
      namespaceValidationService.validateInstance.mockResolvedValue(true);
      storageService.storeHttpLog.mockResolvedValue('log-id-123');

      await service.process(message, instanceId);

      expect(namespaceValidationService.validateInstance).toHaveBeenCalledWith(
        instanceId,
      );
      expect(storageService.storeHttpLog).toHaveBeenCalledWith(message);
    });

    it('should skip processing for invalid namespace', async () => {
      namespaceValidationService.validateInstance.mockResolvedValue(false);

      await service.process(message, instanceId);

      expect(namespaceValidationService.validateInstance).toHaveBeenCalledWith(
        instanceId,
      );
      expect(storageService.storeHttpLog).not.toHaveBeenCalled();
    });

    it('should handle HTTP log with all fields', async () => {
      const fullMessage: HttpLogMessage = {
        instanceId,
        method: 'POST',
        url: '/api/users',
        statusCode: 201,
        requestBody: { name: 'John' },
        responseBody: { id: '123' },
        requestHeaders: { 'Content-Type': 'application/json' },
        responseHeaders: { 'Content-Type': 'application/json' },
        timestamp: '2024-01-01T00:00:00.000Z',
        isMocked: false,
      };

      namespaceValidationService.validateInstance.mockResolvedValue(true);
      storageService.storeHttpLog.mockResolvedValue('log-id-456');

      await service.process(fullMessage, instanceId);

      expect(storageService.storeHttpLog).toHaveBeenCalledWith(fullMessage);
    });

    it('should throw error on storage failure', async () => {
      namespaceValidationService.validateInstance.mockResolvedValue(true);
      storageService.storeHttpLog.mockRejectedValue(
        new Error('Database error'),
      );

      await expect(service.process(message, instanceId)).rejects.toThrow(
        'Database error',
      );

      expect(storageService.storeHttpLog).toHaveBeenCalled();
    });
  });
});
