import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InstanceStatus, RunStatus, NamespaceInstance } from '@prisma/client';
import { RunStorageService } from '../storage/run-storage.service';
import { NamespaceLifecycleService } from '../namespace-lifecycle/namespace-lifecycle.service';
import { RegistryCredentialsService } from '../namespace-lifecycle/registry-credentials.service';

@Injectable()
export class RunCleanupService {
  private readonly logger = new Logger(RunCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: NamespaceLifecycleService,
    private readonly runStorage: RunStorageService,
    private readonly registryCredentials: RegistryCredentialsService,
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

  async teardownExistingRuns() {
    const existingRuns = await this.prisma.run.findMany({
      include: { instances: true },
    });

    for (const run of existingRuns) {
      this.logger.log(`Tearing down existing run ${run.id}`);

      await this.stopInstances(run.instances);

      await this.prisma.run.delete({ where: { id: run.id } });

      for (const instance of run.instances) {
        await this.runStorage.deleteInstance(instance.id);
      }

      await this.registryCredentials.deleteRunSecret(run.id).catch((err) => {
        this.logger.warn(
          `Failed to delete registry secret for run ${run.id}: ${err}`,
        );
      });
    }

    await this.runStorage.deleteGeneratedFiles();
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
