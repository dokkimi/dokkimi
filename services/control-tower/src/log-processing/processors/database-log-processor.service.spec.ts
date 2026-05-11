import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseLogProcessorService } from './database-log-processor.service';
import { StorageService } from '../storage.service';
import { NamespaceValidationService } from '../namespace-validation/namespace-validation.service';
import { DatabaseLogMessageDto } from '../dto/database-log-message.dto';

describe('DatabaseLogProcessorService', () => {
  let service: DatabaseLogProcessorService;
  let storageService: jest.Mocked<StorageService>;
  let namespaceValidationService: jest.Mocked<NamespaceValidationService>;

  beforeEach(async () => {
    const mockStorageService = {
      storeDatabaseLog: jest.fn(),
    };

    const mockNamespaceValidationService = {
      validateInstance: jest.fn(),
      clearCache: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DatabaseLogProcessorService,
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

    service = module.get<DatabaseLogProcessorService>(
      DatabaseLogProcessorService,
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
    const validMessage: DatabaseLogMessageDto = {
      instanceId: 'instance-123',
      instanceItemId: 'item-456',
      databaseType: 'postgresql',
      databaseName: 'postgres-db',
      query: 'SELECT * FROM users WHERE id = $1',
      params: { id: 1 },
      success: true,
      data: [{ id: 1, name: 'Test User', email: 'test@example.com' }],
      rowsAffected: 1,
      duration: 150,
      timestamp: '2024-01-01T00:00:00.000Z',
    };

    it('should process valid database log message', async () => {
      namespaceValidationService.validateInstance.mockResolvedValue(true);
      storageService.storeDatabaseLog.mockResolvedValue('log-id-123');

      await service.process(validMessage, validMessage.instanceId);

      expect(namespaceValidationService.validateInstance).toHaveBeenCalledWith(
        'instance-123',
      );
      expect(storageService.storeDatabaseLog).toHaveBeenCalledWith(
        validMessage,
      );
    });

    it('should skip processing for invalid instance', async () => {
      namespaceValidationService.validateInstance.mockResolvedValue(false);

      await service.process(validMessage, validMessage.instanceId);

      expect(namespaceValidationService.validateInstance).toHaveBeenCalledWith(
        'instance-123',
      );
      expect(storageService.storeDatabaseLog).not.toHaveBeenCalled();
    });

    it('should handle database log with error', async () => {
      const errorMessage: DatabaseLogMessageDto = {
        instanceId: 'instance-123',
        databaseType: 'postgresql',
        databaseName: 'postgres-db',
        query: 'SELECT * FROM invalid_table',
        success: false,
        error: 'relation "invalid_table" does not exist',
        duration: 50,
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      namespaceValidationService.validateInstance.mockResolvedValue(true);
      storageService.storeDatabaseLog.mockResolvedValue('log-id-456');

      await service.process(errorMessage, errorMessage.instanceId);

      expect(storageService.storeDatabaseLog).toHaveBeenCalledWith(
        errorMessage,
      );
    });

    it('should handle database log without optional fields', async () => {
      const minimalMessage: DatabaseLogMessageDto = {
        instanceId: 'instance-123',
        databaseType: 'mysql',
        databaseName: 'mysql-db',
        query: 'SELECT COUNT(*) FROM users',
        success: true,
      };

      namespaceValidationService.validateInstance.mockResolvedValue(true);
      storageService.storeDatabaseLog.mockResolvedValue('log-id-789');

      await service.process(minimalMessage, minimalMessage.instanceId);

      expect(storageService.storeDatabaseLog).toHaveBeenCalledWith(
        minimalMessage,
      );
    });

    it('should handle MongoDB query', async () => {
      const mongoMessage: DatabaseLogMessageDto = {
        instanceId: 'instance-123',
        instanceItemId: 'item-789',
        databaseType: 'mongodb',
        databaseName: 'mongo-db',
        query: '{"name": "Test User"}',
        params: { _collection: 'users' },
        success: true,
        data: [
          {
            _id: '507f1f77bcf86cd799439011',
            name: 'Test User',
            email: 'test@example.com',
          },
        ],
        rowsAffected: 1,
        duration: 200,
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      namespaceValidationService.validateInstance.mockResolvedValue(true);
      storageService.storeDatabaseLog.mockResolvedValue('log-id-mongo');

      await service.process(mongoMessage, mongoMessage.instanceId);

      expect(storageService.storeDatabaseLog).toHaveBeenCalledWith(
        mongoMessage,
      );
    });

    it('should throw error on storage failure', async () => {
      namespaceValidationService.validateInstance.mockResolvedValue(true);
      const storageError = new Error('Database storage failed');
      storageService.storeDatabaseLog.mockRejectedValue(storageError);

      await expect(
        service.process(validMessage, validMessage.instanceId),
      ).rejects.toThrow('Database storage failed');

      expect(storageService.storeDatabaseLog).toHaveBeenCalled();
    });

    it('should handle write query (INSERT/UPDATE/DELETE)', async () => {
      const writeMessage: DatabaseLogMessageDto = {
        instanceId: 'instance-123',
        databaseType: 'postgresql',
        databaseName: 'postgres-db',
        query: 'INSERT INTO users (name, email) VALUES ($1, $2)',
        params: { name: 'New User', email: 'new@example.com' },
        success: true,
        rowsAffected: 1,
        duration: 100,
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      namespaceValidationService.validateInstance.mockResolvedValue(true);
      storageService.storeDatabaseLog.mockResolvedValue('log-id-write');

      await service.process(writeMessage, writeMessage.instanceId);

      expect(storageService.storeDatabaseLog).toHaveBeenCalledWith(
        writeMessage,
      );
    });
  });
});
