import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as k8s from '@kubernetes/client-node';
import { PrismaService } from '../prisma/prisma.service';
import { ColoredLoggerService } from '../logging/colored-logger.service';
import { TelemetryService } from '../telemetry/telemetry.service';
import { InstanceStatus, ItemStatus } from '@prisma/client';
import { RunsService } from '../runs/runs.service';
import { loadKubeConfig } from '../namespace-lifecycle/kubernetes/kubeconfig-loader';

@Injectable()
export class WatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly idlePollIntervalMs: number;
  private readonly activePollIntervalMs: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private isPolling = false;
  private k8sApi: k8s.CoreV1Api;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly logger: ColoredLoggerService,
    private readonly telemetry: TelemetryService,
    private readonly runsService: RunsService,
  ) {
    this.idlePollIntervalMs = this.configService.get<number>(
      'IDLE_POLL_INTERVAL_MS',
    )!;
    this.activePollIntervalMs = this.configService.get<number>(
      'ACTIVE_POLL_INTERVAL_MS',
    )!;

    const kc = loadKubeConfig();
    this.k8sApi = kc.makeApiClient(k8s.CoreV1Api);
  }

  async onModuleInit() {
    this.logger.log(
      `Starting namespace termination poller (idle: ${this.idlePollIntervalMs}ms, active: ${this.activePollIntervalMs}ms)`,
    );
    this.scheduleNextPoll(this.idlePollIntervalMs);
  }

  onModuleDestroy() {
    this.stopPolling();
  }

  private scheduleNextPoll(intervalMs: number) {
    this.pollTimer = setTimeout(() => {
      this.pollTerminatingNamespaces();
    }, intervalMs);
  }

  private stopPolling() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollTerminatingNamespaces() {
    if (this.isPolling) {
      return;
    }
    this.isPolling = true;

    try {
      const terminatingInstances = await this.prisma.namespaceInstance.findMany(
        {
          where: {
            status: {
              in: [InstanceStatus.STOPPING, InstanceStatus.TERMINATING],
            },
          },
          select: { id: true, runId: true },
        },
      );

      if (terminatingInstances.length === 0) {
        this.scheduleNextPoll(this.idlePollIntervalMs);
        return;
      }

      this.logger.log(
        `Checking ${terminatingInstances.length} terminating instance(s)`,
      );

      const results = await Promise.all(
        terminatingInstances.map(async (instance) => {
          const stopped = await this.checkAndMarkStopped(instance.id);
          return stopped ? instance.runId : null;
        }),
      );
      const stoppedRunIds = results.filter(
        (runId): runId is string => runId !== null,
      );

      if (stoppedRunIds.length > 0) {
        const uniqueRunIds = [...new Set(stoppedRunIds)];
        await this.notifyRunsService(uniqueRunIds);
      }

      this.scheduleNextPoll(this.activePollIntervalMs);
    } catch (error) {
      this.logger.error(`Error polling terminating namespaces: ${error}`);
      this.scheduleNextPoll(this.idlePollIntervalMs);
    } finally {
      this.isPolling = false;
    }
  }

  private async checkAndMarkStopped(instanceId: string): Promise<boolean> {
    const k8sNamespace = `dokkimi-${instanceId}`;

    try {
      const podList = await this.k8sApi.listNamespacedPod({
        namespace: k8sNamespace,
      });
      const pods =
        (podList as { body?: k8s.V1PodList }).body?.items ||
        (podList as k8s.V1PodList).items ||
        [];
      if (pods.length > 0) {
        this.logger.log(
          `Namespace ${k8sNamespace} still has ${pods.length} pod(s)`,
        );
        return false;
      }
      this.logger.log(
        `All pods gone in ${k8sNamespace}, marking instance as STOPPED`,
      );
      await this.markInstanceStopped(instanceId);
      return true;
    } catch (error: unknown) {
      const err = error as Record<string, unknown> & {
        response?: { statusCode?: number };
      };
      const statusCode = err.code || err.statusCode || err.response?.statusCode;
      if (statusCode === 404) {
        this.logger.log(
          `Namespace ${k8sNamespace} deleted, marking instance as STOPPED`,
        );
        await this.markInstanceStopped(instanceId);
        return true;
      } else {
        this.logger.error(`Error checking namespace ${k8sNamespace}: ${error}`);
        return false;
      }
    }
  }

  private async notifyRunsService(runIds: string[]) {
    try {
      await this.runsService.handleInstancesStopped(runIds);
    } catch (err) {
      this.logger.error(
        `Failed to notify runs service of stopped instances: ${err}`,
      );
      this.telemetry.track('cws_notify_runs_failed', {
        module: 'cluster-watcher',
      });
    }
  }

  private async markInstanceStopped(instanceId: string) {
    try {
      await this.prisma.namespaceInstance.update({
        where: { id: instanceId },
        data: {
          status: InstanceStatus.STOPPED,
          stoppedAt: new Date(),
        },
      });

      await this.prisma.instanceItem.updateMany({
        where: { instanceId },
        data: { status: ItemStatus.STOPPED },
      });

      this.logger.log(`Instance ${instanceId} marked as STOPPED`);
    } catch (error) {
      this.logger.error(
        `Failed to mark instance ${instanceId} as STOPPED: ${error}`,
      );
    }
  }
}
