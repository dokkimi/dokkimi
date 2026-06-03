import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ReadinessStatus } from '@prisma/client';
import { HealthService } from './health.service';
import { PrismaService } from '../prisma/prisma.service';

describe('HealthService', () => {
  let service: HealthService;

  const mockPrismaService = {
    client: {
      $queryRaw: jest.fn(),
    },
    run: {
      findFirst: jest.fn(),
    },
    instanceItem: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<HealthService>(HealthService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getHealthStatus', () => {
    it('should return healthy status when all checks pass', async () => {
      mockPrismaService.client.$queryRaw.mockResolvedValue([{ '1': 1 }]);
      mockPrismaService.run.findFirst.mockResolvedValue(null);

      const result = await service.getHealthStatus();

      expect(result.status).toBe('healthy');
      expect(result.checks.database.status).toBe('healthy');
      expect(result.checks.prisma.status).toBe('healthy');
      expect(result.checks.database.latency).toBeGreaterThanOrEqual(0);
      expect(result.checks.prisma.latency).toBeGreaterThanOrEqual(0);
      expect(result.timestamp).toBeDefined();
      expect(result.uptime).toBeGreaterThanOrEqual(0);
    });

    it('should return unhealthy status when database check fails', async () => {
      mockPrismaService.client.$queryRaw.mockRejectedValue(
        new Error('Database connection failed'),
      );
      mockPrismaService.run.findFirst.mockResolvedValue(null);

      const result = await service.getHealthStatus();

      expect(result.status).toBe('unhealthy');
      expect(result.checks.database.status).toBe('unhealthy');
      expect(result.checks.database.error).toBe('Database connection failed');
    });

    it('should return unhealthy status when Prisma check fails', async () => {
      mockPrismaService.client.$queryRaw.mockResolvedValue([{ '1': 1 }]);
      mockPrismaService.run.findFirst.mockRejectedValue(
        new Error('Prisma connection failed'),
      );

      const result = await service.getHealthStatus();

      expect(result.status).toBe('unhealthy');
      expect(result.checks.prisma.status).toBe('unhealthy');
      expect(result.checks.prisma.error).toBe('Prisma connection failed');
    });

    it('should include version if APP_VERSION is set', async () => {
      const originalVersion = process.env.APP_VERSION;
      process.env.APP_VERSION = '1.0.0';

      mockPrismaService.client.$queryRaw.mockResolvedValue([{ '1': 1 }]);
      mockPrismaService.run.findFirst.mockResolvedValue(null);

      const result = await service.getHealthStatus();

      expect(result.version).toBe('1.0.0');

      if (originalVersion !== undefined) {
        process.env.APP_VERSION = originalVersion;
      } else {
        delete process.env.APP_VERSION;
      }
    });

    it('should fall back to npm_package_version when APP_VERSION is not set', async () => {
      const originalAppVersion = process.env.APP_VERSION;
      const originalNpmVersion = process.env.npm_package_version;
      delete process.env.APP_VERSION;
      process.env.npm_package_version = '2.3.4';

      mockPrismaService.client.$queryRaw.mockResolvedValue([{ '1': 1 }]);
      mockPrismaService.run.findFirst.mockResolvedValue(null);

      const result = await service.getHealthStatus();

      expect(result.version).toBe('2.3.4');

      if (originalAppVersion !== undefined) {
        process.env.APP_VERSION = originalAppVersion;
      }
      if (originalNpmVersion !== undefined) {
        process.env.npm_package_version = originalNpmVersion;
      } else {
        delete process.env.npm_package_version;
      }
    });

    it('should return unhealthy when all checks fail', async () => {
      mockPrismaService.client.$queryRaw.mockRejectedValue(
        new Error('DB down'),
      );
      mockPrismaService.run.findFirst.mockRejectedValue(
        new Error('Prisma down'),
      );

      const result = await service.getHealthStatus();

      expect(result.status).toBe('unhealthy');
      expect(result.checks.database.status).toBe('unhealthy');
      expect(result.checks.prisma.status).toBe('unhealthy');
    });

    it('should include service name as control-tower', async () => {
      mockPrismaService.client.$queryRaw.mockResolvedValue([{ '1': 1 }]);
      mockPrismaService.run.findFirst.mockResolvedValue(null);

      const result = await service.getHealthStatus();

      expect(result.service).toBe('control-tower');
    });

    it('should handle non-Error objects thrown by database check', async () => {
      mockPrismaService.client.$queryRaw.mockRejectedValue('string error');
      mockPrismaService.run.findFirst.mockResolvedValue(null);

      const result = await service.getHealthStatus();

      expect(result.status).toBe('unhealthy');
      expect(result.checks.database.status).toBe('unhealthy');
      expect(result.checks.database.error).toBe('Unknown error');
    });

    it('should handle non-Error objects thrown by prisma check', async () => {
      mockPrismaService.client.$queryRaw.mockResolvedValue([{ '1': 1 }]);
      mockPrismaService.run.findFirst.mockRejectedValue(42);

      const result = await service.getHealthStatus();

      expect(result.status).toBe('unhealthy');
      expect(result.checks.prisma.status).toBe('unhealthy');
      expect(result.checks.prisma.error).toBe('Unknown error');
    });
  });

  describe('updateReadinessStatus', () => {
    const baseDto = {
      instanceId: 'inst-123',
      instanceItemId: 'item-456',
      instanceItemName: 'my-service',
      ready: true,
      timestamp: '2026-01-15T10:00:00.000Z',
    };

    it('should update readiness to READY when ready is true', async () => {
      mockPrismaService.instanceItem.findFirst.mockResolvedValue({
        id: 'item-456',
      });
      mockPrismaService.instanceItem.update.mockResolvedValue({});

      await service.updateReadinessStatus(baseDto);

      expect(mockPrismaService.instanceItem.findFirst).toHaveBeenCalledWith({
        where: {
          id: 'item-456',
          instanceId: 'inst-123',
        },
      });
      expect(mockPrismaService.instanceItem.update).toHaveBeenCalledWith({
        where: { id: 'item-456' },
        data: {
          readinessStatus: ReadinessStatus.READY,
          readinessLastChecked: new Date('2026-01-15T10:00:00.000Z'),
        },
      });
    });

    it('should update readiness to NOT_READY when ready is false', async () => {
      mockPrismaService.instanceItem.findFirst.mockResolvedValue({
        id: 'item-456',
      });
      mockPrismaService.instanceItem.update.mockResolvedValue({});

      await service.updateReadinessStatus({ ...baseDto, ready: false });

      expect(mockPrismaService.instanceItem.update).toHaveBeenCalledWith({
        where: { id: 'item-456' },
        data: {
          readinessStatus: ReadinessStatus.NOT_READY,
          readinessLastChecked: new Date('2026-01-15T10:00:00.000Z'),
        },
      });
    });

    it('should throw BadRequestException when instance item is not found', async () => {
      mockPrismaService.instanceItem.findFirst.mockResolvedValue(null);

      await expect(service.updateReadinessStatus(baseDto)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.updateReadinessStatus(baseDto)).rejects.toThrow(
        'Instance item ID item-456 not found in instance inst-123',
      );
      expect(mockPrismaService.instanceItem.update).not.toHaveBeenCalled();
    });

    it('should wrap unexpected errors from update in BadRequestException', async () => {
      mockPrismaService.instanceItem.findFirst.mockResolvedValue({
        id: 'item-456',
      });
      mockPrismaService.instanceItem.update.mockRejectedValue(
        new Error('DB write failed'),
      );

      await expect(service.updateReadinessStatus(baseDto)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.updateReadinessStatus(baseDto)).rejects.toThrow(
        'Failed to update readiness status: DB write failed',
      );
    });

    it('should handle non-Error objects thrown during update', async () => {
      mockPrismaService.instanceItem.findFirst.mockResolvedValue({
        id: 'item-456',
      });
      mockPrismaService.instanceItem.update.mockRejectedValue(
        'unexpected string error',
      );

      await expect(service.updateReadinessStatus(baseDto)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.updateReadinessStatus(baseDto)).rejects.toThrow(
        'Failed to update readiness status: Unknown error',
      );
    });
  });
});
