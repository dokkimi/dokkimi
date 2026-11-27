import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ReadinessStatus } from '@prisma/client';
import { HealthService } from './health.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { DOKKIMI_VERSION } from '@dokkimi/config';

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
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              ({ MAX_CONCURRENT_NAMESPACES: 4, MAX_BOOTING_NAMESPACES: 1 })[
                key
              ],
          },
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

    // The CLI compares it with what it resolves, to apply a change
    it('reports the concurrency it runs with', async () => {
      mockPrismaService.client.$queryRaw.mockResolvedValue([{ '1': 1 }]);
      mockPrismaService.run.findFirst.mockResolvedValue(null);

      expect((await service.getHealthStatus()).concurrency).toEqual({
        maxConcurrentTests: 4,
        maxBootingTests: 1,
      });
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

    it('reports the code version, not the image tag', async () => {
      const originalVersion = process.env.DOKKIMI_APP_VERSION;
      process.env.DOKKIMI_APP_VERSION = 'latest';
      mockPrismaService.client.$queryRaw.mockResolvedValue([{ '1': 1 }]);
      mockPrismaService.run.findFirst.mockResolvedValue(null);

      const result = await service.getHealthStatus();

      expect(result.version).toBe(DOKKIMI_VERSION);
      if (originalVersion !== undefined) {
        process.env.DOKKIMI_APP_VERSION = originalVersion;
      } else {
        delete process.env.DOKKIMI_APP_VERSION;
      }
    });

    it('reports whether a run is active', async () => {
      mockPrismaService.client.$queryRaw.mockResolvedValue([{ '1': 1 }]);
      mockPrismaService.run.findFirst.mockResolvedValue(null);
      expect((await service.getHealthStatus()).activeRun).toBe(false);

      mockPrismaService.run.findFirst.mockResolvedValue({ id: 'run-1' });
      expect((await service.getHealthStatus()).activeRun).toBe(true);
      expect(mockPrismaService.run.findFirst).toHaveBeenCalledWith({
        where: { status: { in: ['PENDING', 'RUNNING'] } },
        select: { id: true },
      });
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
