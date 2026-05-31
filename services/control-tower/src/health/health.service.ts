import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReadinessStatus } from '@prisma/client';
import { KubernetesClientService } from '../namespace-lifecycle/kubernetes/kubernetes-client.service';
import { HealthStatusDto } from './dto/health-status.dto';

export interface HealthCheckResult {
  status: 'healthy' | 'unhealthy' | 'degraded';
  message?: string;
  latency?: number;
  error?: string;
}

export interface HealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded';
  service: string;
  timestamp: string;
  uptime: number;
  version?: string;
  checks: {
    database: HealthCheckResult;
    kubernetes: HealthCheckResult;
    prisma: HealthCheckResult;
  };
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startTime = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly k8sClient: KubernetesClientService,
  ) {}

  async getHealthStatus(): Promise<HealthStatus> {
    const [database, kubernetes, prisma] = await Promise.all([
      this.checkDatabase(),
      this.checkKubernetes(),
      this.checkPrisma(),
    ]);

    // Determine overall status
    const allHealthy =
      database.status === 'healthy' &&
      kubernetes.status === 'healthy' &&
      prisma.status === 'healthy';

    const anyUnhealthy =
      database.status === 'unhealthy' ||
      kubernetes.status === 'unhealthy' ||
      prisma.status === 'unhealthy';

    const overallStatus = allHealthy
      ? 'healthy'
      : anyUnhealthy
        ? 'unhealthy'
        : 'degraded';

    return {
      status: overallStatus,
      service: 'control-tower',
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      version: process.env.APP_VERSION || process.env.npm_package_version,
      checks: {
        database,
        kubernetes,
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

  private async checkKubernetes(): Promise<HealthCheckResult> {
    const startTime = Date.now();
    try {
      await this.k8sClient.core.listNamespace();
      const latency = Date.now() - startTime;
      this.logger.log(`Kubernetes health check passed (${latency}ms)`);

      return {
        status: 'healthy',
        message: 'Kubernetes API connection successful',
        latency,
      };
    } catch {
      const latency = Date.now() - startTime;
      // K8s is optional — Docker mode doesn't use it.
      return {
        status: 'healthy',
        message: 'Kubernetes not available (Docker mode)',
        latency,
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

  /**
   * Updates the readiness status of an instance item — called by interceptor
   * sidecars every few seconds to report whether their partnered service is up.
   */
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
