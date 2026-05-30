import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { TelemetryService } from '../telemetry/telemetry.service';
import { InstanceStatus, RunStatus } from '@prisma/client';
import { RunStorageService } from '../storage/run-storage.service';
import { DockerDeployerService } from '../namespace-lifecycle/docker/docker-deployer.service';
import { DeploymentContext } from '../namespace-deployer/deployment-context.types';
import { rawDefinitionToDeployable } from './definition-converter';

@Injectable()
export class DeploymentSchedulerService {
  private readonly logger = new Logger(DeploymentSchedulerService.name);
  private readonly maxConcurrentNamespaces: number;
  private readonly maxBootingNamespaces: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly deployer: DockerDeployerService,
    private readonly runStorage: RunStorageService,
    private readonly configService: ConfigService,
    private readonly telemetry: TelemetryService,
  ) {
    this.maxConcurrentNamespaces = this.configService.get<number>(
      'MAX_CONCURRENT_NAMESPACES',
    )!;
    this.maxBootingNamespaces = this.configService.get<number>(
      'MAX_BOOTING_NAMESPACES',
    )!;
  }

  async handleInstancesStopped(runIds: string[]) {
    const uniqueRunIds = [...new Set(runIds)];
    for (const runId of uniqueRunIds) {
      try {
        await this.checkRunCompletion(runId);
        await this.deployPendingInstances(runId);
      } catch (err) {
        this.logger.error(
          `Failed to handle instances-stopped for run ${runId}: ${err}`,
        );
      }
    }
  }

  async deployPendingInstances(runId: string) {
    const run = await this.prisma.run.findUnique({
      where: { id: runId },
      include: { instances: true },
    });
    if (!run) {
      return;
    }

    if (run.status !== RunStatus.PENDING && run.status !== RunStatus.RUNNING) {
      return;
    }

    const activeCount = run.instances.filter(
      (inst) =>
        inst.status === InstanceStatus.STARTING ||
        inst.status === InstanceStatus.RUNNING ||
        inst.status === InstanceStatus.STOPPING ||
        inst.status === InstanceStatus.TERMINATING,
    ).length;
    const startingCount = run.instances.filter(
      (inst) => inst.status === InstanceStatus.STARTING,
    ).length;
    const maxConcurrentStarting = this.maxBootingNamespaces;

    const slotsAvailable = Math.min(
      this.maxConcurrentNamespaces - activeCount,
      maxConcurrentStarting - startingCount,
    );
    if (slotsAvailable <= 0) {
      return;
    }

    const pendingInstances = run.instances.filter(
      (inst) => inst.status === InstanceStatus.PENDING,
    );

    let deployed = 0;
    for (const instance of pendingInstances) {
      if (deployed >= slotsAvailable) {
        break;
      }

      const hasDefinition = await this.runStorage.hasDefinition(instance.id);
      if (!hasDefinition) {
        continue;
      }

      await this.prisma.namespaceInstance.update({
        where: { id: instance.id },
        data: { status: InstanceStatus.STARTING },
      });
      const ctx = await this.rebuildDeploymentContext(runId, instance.id);
      this.deployInBackground(ctx, runId);
      deployed++;
    }

    if (deployed > 0) {
      this.logger.log(
        `Deployed ${deployed} pending instance(s) for run ${runId} (${startingCount + deployed}/${maxConcurrentStarting} starting, ${activeCount + deployed}/${this.maxConcurrentNamespaces} active)`,
      );
    }
  }

  async checkRunCompletion(runId: string) {
    const run = await this.prisma.run.findUnique({
      where: { id: runId },
      include: { instances: true },
    });
    if (!run) {
      return;
    }

    if (
      run.status === RunStatus.COMPLETED ||
      run.status === RunStatus.FAILED ||
      run.status === RunStatus.CANCELLED
    ) {
      return;
    }

    const terminalStatuses = new Set<InstanceStatus>([
      InstanceStatus.STOPPED,
      InstanceStatus.FAILED,
      InstanceStatus.STOPPING,
      InstanceStatus.TERMINATING,
    ]);

    let allDone = true;
    let anyFailed = false;

    for (const inst of run.instances) {
      const isTerminal =
        terminalStatuses.has(inst.status) ||
        inst.testStatus === 'PASSED' ||
        inst.testStatus === 'FAILED';

      if (isTerminal) {
        if (
          inst.status === InstanceStatus.FAILED ||
          inst.testStatus === 'FAILED'
        ) {
          anyFailed = true;
        }
        continue;
      }

      if (inst.status === InstanceStatus.PENDING) {
        const hasDefinition = await this.runStorage.hasDefinition(inst.id);
        if (hasDefinition) {
          allDone = false;
          break;
        }
        anyFailed = true;
        continue;
      }

      allDone = false;
      break;
    }

    if (!allDone) {
      return;
    }

    await this.prisma.run.update({
      where: { id: runId },
      data: {
        status: anyFailed ? RunStatus.FAILED : RunStatus.COMPLETED,
        completedAt: new Date(),
      },
    });

    const passedCount = run.instances.filter(
      (i) => i.testStatus === 'PASSED',
    ).length;
    const failedCount = run.instances.filter(
      (i) => i.testStatus === 'FAILED' || i.status === InstanceStatus.FAILED,
    ).length;
    const runDurationMs = run.createdAt
      ? Date.now() - new Date(run.createdAt).getTime()
      : undefined;

    this.telemetry.track('ct_run_completed', {
      passed_count: passedCount,
      failed_count: failedCount,
      run_duration_ms: runDurationMs,
    });

    this.logger.log(
      `Run ${runId} completed: ${anyFailed ? 'FAILED' : 'COMPLETED'}`,
    );
  }

  private deployInBackground(ctx: DeploymentContext, runId: string) {
    this.deployer
      .deploy(ctx)
      .then(() => {
        this.logger.log(`Instance ${ctx.instanceId} deployed successfully`);
      })
      .catch(async (err) => {
        this.logger.error(
          `Deployment failed for instance ${ctx.instanceId}:`,
          err,
        );
        try {
          await this.prisma.namespaceInstance.update({
            where: { id: ctx.instanceId },
            data: {
              status: InstanceStatus.FAILED,
              errorMessage: err instanceof Error ? err.message : String(err),
              stoppedAt: new Date(),
            },
          });
        } catch (updateErr) {
          this.logger.error(
            `Failed to mark instance ${ctx.instanceId} as FAILED:`,
            updateErr,
          );
        }
        try {
          await this.checkRunCompletion(runId);
          await this.deployPendingInstances(runId);
        } catch (e) {
          this.logger.error(
            `Failed to handle deployment failure for run ${runId}:`,
            e,
          );
        }
      });
  }

  private async rebuildDeploymentContext(
    runId: string,
    instanceId: string,
  ): Promise<DeploymentContext> {
    const definition = await this.runStorage.readDefinition(instanceId);
    const items = await this.prisma.instanceItem.findMany({
      where: { instanceId },
    });
    const instanceItemIds = new Map(
      items.map((item) => [item.itemDefinitionName, item.id]),
    );
    return {
      runId,
      instanceId,
      k8sNamespaceName: `dokkimi-${instanceId}`,
      instanceItemIds,
      definition: rawDefinitionToDeployable(definition),
    };
  }
}
