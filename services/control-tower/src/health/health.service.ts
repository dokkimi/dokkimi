import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReadinessStatus } from '@prisma/client';
import { HealthStatusDto } from './dto/health-status.dto';

export interface HealthCheckResult {
  status: 'healthy' | 'unhealthy';
  message?: string;
  latency?: number;
  error?: string;
}

export interface HealthStatus {
  status: 'healthy' | 'unhealthy';
  service: string;
  timestamp: string;
  uptime: number;
  version?: string;
  checks: {
    database: HealthCheckResult;
    prisma: HealthCheckResult;
  };
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startTime = Date.now();

  constructor(private readonly prisma: PrismaService) {}

  async getHealthStatus(): Promise<HealthStatus> {
    const [database, prisma] = await Promise.all([
      this.checkDatabase(),
      this.checkPrisma(),
    ]);

    const allHealthy =
      database.status === 'healthy' && prisma.status === 'healthy';

    return {
      status: allHealthy ? 'healthy' : 'unhealthy',
      service: 'control-tower',
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      version: process.env.APP_VERSION || process.env.npm_package_version,
      checks: {
        database,
        prisma,
      },
    };
  }

  private async checkDatabase(): Promise<HealthCheckResult> {
    const startTime = Date.now();
    try {
      await this.prisma.client.$queryRaw`SELECT 1`;
      const latency = Date.now() - startTime;

      return {
        status: 'healthy',
        message: 'Database connection successful',
        latency,
      };
    } catch (error) {
      const latency = Date.now() - startTime;
      this.logger.error(
        'Database health check failed',
        error instanceof Error ? error.stack : String(error),
      );
      return {
        status: 'unhealthy',
        message: 'Database connection failed',
        latency,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async checkPrisma(): Promise<HealthCheckResult> {
    const startTime = Date.now();
    try {
      await this.prisma.run.findFirst({ take: 1 });
      const latency = Date.now() - startTime;

      return {
        status: 'healthy',
        message: 'Prisma client connection successful',
        latency,
      };
    } catch (error) {
      const latency = Date.now() - startTime;
      this.logger.error(
        'Prisma health check failed',
        error instanceof Error ? error.stack : String(error),
      );
      return {
        status: 'unhealthy',
        message: 'Prisma client connection failed',
        latency,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async updateReadinessStatus(dto: HealthStatusDto): Promise<void> {
    try {
      const instanceItem = await this.prisma.instanceItem.findFirst({
        where: {
          id: dto.instanceItemId,
          instanceId: dto.instanceId,
        },
      });

      if (!instanceItem) {
        this.logger.warn(
          `Instance item ID ${dto.instanceItemId} not found in instance ${dto.instanceId} (item name: ${dto.instanceItemName})`,
        );
        throw new BadRequestException(
          `Instance item ID ${dto.instanceItemId} not found in instance ${dto.instanceId}`,
        );
      }

      const timestamp = new Date(dto.timestamp);
      const readinessStatus: ReadinessStatus = dto.ready
        ? ReadinessStatus.READY
        : ReadinessStatus.NOT_READY;

      await this.prisma.instanceItem.update({
        where: { id: instanceItem.id },
        data: {
          readinessStatus,
          readinessLastChecked: timestamp,
        },
      });

      this.logger.log(
        `Updated readiness status for instance item '${dto.instanceItemName}' (${dto.instanceItemId}) in instance ${dto.instanceId}: ${readinessStatus}`,
      );
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to update readiness status for instance item '${dto.instanceItemName}' (${dto.instanceItemId}) in instance ${dto.instanceId}: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new BadRequestException(
        `Failed to update readiness status: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}
