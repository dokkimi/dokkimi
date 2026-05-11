import { Test, TestingModule } from '@nestjs/testing';
import { NamespaceValidationService } from './namespace-validation.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('NamespaceValidationService', () => {
  let service: NamespaceValidationService;
  let prismaService: {
    namespaceInstance: {
      findUnique: jest.Mock;
    };
  };

  const mockPrismaService = {
    namespaceInstance: {
      findUnique: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NamespaceValidationService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<NamespaceValidationService>(
      NamespaceValidationService,
    );
    prismaService = module.get(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    service.clearCache();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('validateInstance', () => {
    const instanceId = 'test-instance-id';

    it('should return true if instance exists', async () => {
      prismaService.namespaceInstance.findUnique.mockResolvedValue({
        id: instanceId,
      });

      const result = await service.validateInstance(instanceId);

      expect(result).toBe(true);
      expect(prismaService.namespaceInstance.findUnique).toHaveBeenCalledWith({
        where: { id: instanceId },
        select: { id: true },
      });
    });

    it('should return false if instance does not exist', async () => {
      prismaService.namespaceInstance.findUnique.mockResolvedValue(null);

      const result = await service.validateInstance(instanceId);

      expect(result).toBe(false);
      expect(prismaService.namespaceInstance.findUnique).toHaveBeenCalledWith({
        where: { id: instanceId },
        select: { id: true },
      });
    });

    it('should cache results', async () => {
      prismaService.namespaceInstance.findUnique.mockResolvedValue({
        id: instanceId,
      });

      // First call
      await service.validateInstance(instanceId);
      expect(prismaService.namespaceInstance.findUnique).toHaveBeenCalledTimes(
        1,
      );

      // Second call should use cache
      await service.validateInstance(instanceId);
      expect(prismaService.namespaceInstance.findUnique).toHaveBeenCalledTimes(
        1,
      );
    });

    it('should return true on database error (safety measure)', async () => {
      const error = new Error('Database error');
      prismaService.namespaceInstance.findUnique.mockRejectedValue(error);

      const result = await service.validateInstance(instanceId);

      expect(result).toBe(true); // Safety measure - assume exists on error
    });

    it('should clear cache after TTL expires', async () => {
      jest.useFakeTimers();
      prismaService.namespaceInstance.findUnique.mockResolvedValue({
        id: instanceId,
      });

      // First call
      await service.validateInstance(instanceId);
      expect(prismaService.namespaceInstance.findUnique).toHaveBeenCalledTimes(
        1,
      );

      // Fast-forward time past cache TTL (1 minute)
      jest.advanceTimersByTime(61000);

      // Second call should query database again
      await service.validateInstance(instanceId);
      expect(prismaService.namespaceInstance.findUnique).toHaveBeenCalledTimes(
        2,
      );

      jest.useRealTimers();
    });
  });

  describe('clearCache', () => {
    it('should clear cache for specific instance', async () => {
      const instanceId1 = 'instance-1';
      const instanceId2 = 'instance-2';

      prismaService.namespaceInstance.findUnique.mockResolvedValue({
        id: instanceId1,
      });

      await service.validateInstance(instanceId1);
      await service.validateInstance(instanceId2);

      service.clearCache(instanceId1);

      // Should query again for instance-1 (but instance-2 is still cached)
      await service.validateInstance(instanceId1);
      // First call for instanceId1, second for instanceId2, third for instanceId1 after clear
      expect(prismaService.namespaceInstance.findUnique).toHaveBeenCalledTimes(
        3,
      );
    });

    it('should clear all cache when no instance specified', async () => {
      const instanceId = 'test-instance';

      prismaService.namespaceInstance.findUnique.mockResolvedValue({
        id: instanceId,
      });

      await service.validateInstance(instanceId);
      service.clearCache();

      // Should query again
      await service.validateInstance(instanceId);
      expect(prismaService.namespaceInstance.findUnique).toHaveBeenCalledTimes(
        2,
      );
    });
  });
});
