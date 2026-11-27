import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReadinessStatus, RunStatus } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { Concurrency, DOKKIMI_VERSION } from '@dokkimi/config';
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
  version: string;
  /** A run is pending or running: the CLI restarts an old version only when not */
  activeRun: boolean;
  /** What it runs with: the CLI restarts it, when idle, to apply a change */
  concurrency: Concurrency;
  checks: {
    database: HealthCheckResult;
    prisma: HealthCheckResult;
  };
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startTime = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async getHealthStatus(): Promise<HealthStatus> {
    const [database, { result: prisma, activeRun }] = await Promise.all([
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
      version: DOKKIMI_VERSION,
      activeRun,
      concurrency: {
        maxConcurrentTests: this.config.get<number>(
          'MAX_CONCURRENT_NAMESPACES',
        )!,
        maxBootingTests: this.config.get<number>('MAX_BOOTING_NAMESPACES')!,
      },
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

  private async checkPrisma(): Promise<{
    result: HealthCheckResult;
    activeRun: boolean;
  }> {
    const startTime = Date.now();
    try {
      const active = await this.prisma.run.findFirst({
        where: { status: { in: [RunStatus.PENDING, RunStatus.RUNNING] } },
        select: { id: true },
      });
      const latency = Date.now() - startTime;

      return {
        result: {
          status: 'healthy',
          message: 'Prisma client connection successful',
          latency,
        },
        activeRun: active !== null,
      };
    } catch (error) {
      const latency = Date.now() - startTime;
      this.logger.error(
        'Prisma health check failed',
        error instanceof Error ? error.stack : String(error),
      );
      return {
        result: {
          status: 'unhealthy',
          message: 'Prisma client connection failed',
          latency,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        activeRun: false,
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
