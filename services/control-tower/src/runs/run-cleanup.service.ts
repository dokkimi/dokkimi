import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InstanceStatus, RunStatus, NamespaceInstance } from '@prisma/client';
import { RunStorageService } from '../storage/run-storage.service';
import { NamespaceLifecycleService } from '../namespace-lifecycle/namespace-lifecycle.service';
import { DockerRegistryService } from '../namespace-lifecycle/docker/docker-registry.service';
import { DockerClientService } from '../namespace-lifecycle/docker/docker-client.service';
import { getMaxRunHistory } from '@dokkimi/config';

@Injectable()
export class RunCleanupService {
  private readonly logger = new Logger(RunCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: NamespaceLifecycleService,
    private readonly dockerClient: DockerClientService,
    private readonly runStorage: RunStorageService,
    private readonly registryService: DockerRegistryService,
  ) {}

  async stopInstances(instances: NamespaceInstance[]) {
    await Promise.allSettled(
      instances.map(async (instance) => {
        if (
          instance.status === InstanceStatus.STARTING ||
          instance.status === InstanceStatus.RUNNING
        ) {
          await this.lifecycle.stopInstance(instance.id).catch((err) => {
            this.logger.warn(`Failed to stop instance ${instance.id}: ${err}`);
          });
        }

        if (
          instance.status !== InstanceStatus.STOPPED &&
          instance.status !== InstanceStatus.FAILED &&
          instance.status !== InstanceStatus.STOPPING &&
          instance.status !== InstanceStatus.TERMINATING
        ) {
          await this.prisma.namespaceInstance.update({
            where: { id: instance.id },
            data: {
              status: InstanceStatus.FAILED,
              stoppedAt: new Date(),
            },
          });
        }
      }),
    );
  }

  async prepareForNewRun(projectPath?: string) {
    const maxRunHistory = getMaxRunHistory(projectPath);
    // Stop the active run for this project (if any)
    const activeRuns = await this.prisma.run.findMany({
      where: {
        status: { in: [RunStatus.PENDING, RunStatus.RUNNING] },
        ...(projectPath ? { projectPath } : {}),
      },
      include: { instances: true },
    });

    for (const run of activeRuns) {
      this.logger.log(
        `Stopping active run ${run.id} for project ${projectPath ?? '(global)'}`,
      );
      await this.stopInstances(run.instances);
      await this.prisma.run.update({
        where: { id: run.id },
        data: {
          status: RunStatus.CANCELLED,
          cancelledAt: new Date(),
        },
      });
      this.registryService.clearCredentials(run.id);
    }

    // Prune completed runs beyond maxRunHistory for this project
    const completedRuns = await this.prisma.run.findMany({
      where: {
        status: {
          in: [RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.CANCELLED],
        },
        ...(projectPath ? { projectPath } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: { instances: true },
    });

    // Keep maxRunHistory - 1 completed runs because the new run about to be
    // created will occupy a slot, bringing the total to maxRunHistory.
    const keepCount = Math.max(1, maxRunHistory - 1);
    const runsToDelete = completedRuns.slice(keepCount);

    for (const run of runsToDelete) {
      this.logger.log(
        `Pruning old run ${run.id} (created ${run.createdAt.toISOString()})`,
      );

      await this.prisma.run.delete({ where: { id: run.id } });

      if (run.projectPath) {
        await this.runStorage.deleteRunDir(run.projectPath, run.createdAt);
      }

      this.registryService.clearCredentials(run.id);
    }

    if (runsToDelete.length > 0) {
      await this.prisma.$queryRaw`VACUUM`;
      this.logger.log(
        `Pruned ${runsToDelete.length} old run(s) for project ${projectPath ?? '(global)'}`,
      );
    }
  }

  async recoverStaleRuns() {
    const activeRuns = await this.prisma.run.findMany({
      where: {
        status: { in: [RunStatus.PENDING, RunStatus.RUNNING] },
      },
      include: { instances: true },
    });

    for (const run of activeRuns) {
      const hasLiveInstance = await this.hasLiveContainers(run.instances);
      if (!hasLiveInstance) {
        this.logger.warn(
          `Run ${run.id} is ${run.status} but has no live containers — marking as FAILED`,
        );
        await this.stopInstances(run.instances);
        await this.prisma.run.update({
          where: { id: run.id },
          data: {
            status: RunStatus.FAILED,
            completedAt: new Date(),
          },
        });
        this.registryService.clearCredentials(run.id);
      }
    }
  }

  private async hasLiveContainers(
    instances: NamespaceInstance[],
  ): Promise<boolean> {
    for (const instance of instances) {
      if (instance.status === InstanceStatus.PENDING) {
        return true;
      }
      if (
        instance.status === InstanceStatus.STARTING ||
        instance.status === InstanceStatus.RUNNING
      ) {
        const exists = await this.dockerClient.networkExists(instance.id);
        if (exists) {
          return true;
        }
      }
    }
    return false;
  }

  async recoverOrphanedRuns() {
    const orphanedRuns = await this.prisma.run.findMany({
      where: {
        status: { in: [RunStatus.PENDING, RunStatus.RUNNING] },
      },
      include: { instances: true },
    });

    for (const run of orphanedRuns) {
      this.logger.warn(`Found orphaned run ${run.id}, marking as CANCELLED`);

      await this.stopInstances(run.instances);

      await this.prisma.run.update({
        where: { id: run.id },
        data: {
          status: RunStatus.CANCELLED,
          cancelledAt: new Date(),
        },
      });
    }

    if (orphanedRuns.length > 0) {
      this.logger.log(
        `Recovered ${orphanedRuns.length} orphaned run(s) on startup`,
      );
    }
  }
}
