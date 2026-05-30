import { Injectable, Logger } from '@nestjs/common';
import { InstanceStatus, ItemStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NamespaceInstanceService } from '../namespace/namespace-instance.service';
import { InstanceItemService } from '../namespace/instance-item.service';
import { DockerDeployerService } from './docker/docker-deployer.service';

@Injectable()
export class NamespaceLifecycleService {
  private readonly logger = new Logger(NamespaceLifecycleService.name);

  constructor(
    private readonly dockerDeployer: DockerDeployerService,
    private readonly prisma: PrismaService,
    private readonly namespaceInstanceService: NamespaceInstanceService,
    private readonly instanceItemService: InstanceItemService,
  ) {}

  async stopInstance(instanceId: string): Promise<void> {
    this.logger.log(`Stopping instance ${instanceId}`);

    try {
      await this.namespaceInstanceService.updateInstanceStatus(
        instanceId,
        InstanceStatus.STOPPING,
      );

      await this.instanceItemService.markAllStopping(instanceId);

      await this.dockerDeployer.teardown(instanceId);

      // Docker teardown is synchronous (containers removed immediately),
      // so we can mark as STOPPED directly — no polling needed.
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

      this.logger.log(`Instance ${instanceId} stopped`);
    } catch (err) {
      this.logger.error(`Failed to stop instance ${instanceId}:`, err);

      try {
        await this.namespaceInstanceService.updateInstanceStatus(
          instanceId,
          InstanceStatus.FAILED,
        );
      } catch {
        // Ignore secondary errors
      }

      throw err;
    }
  }
}
