import { Injectable, Logger } from '@nestjs/common';
import { InstanceStatus } from '@prisma/client';
import { NamespaceInstanceService } from '../namespace/namespace-instance.service';
import { InstanceItemService } from '../namespace/instance-item.service';
import { KubernetesClientService } from './kubernetes/kubernetes-client.service';

@Injectable()
export class NamespaceLifecycleService {
  private readonly logger = new Logger(NamespaceLifecycleService.name);

  constructor(
    private readonly k8sClient: KubernetesClientService,
    private readonly namespaceInstanceService: NamespaceInstanceService,
    private readonly instanceItemService: InstanceItemService,
  ) {}

  async stopInstance(instanceId: string): Promise<void> {
    this.logger.log(`Stopping instance ${instanceId}`);

    const instance =
      await this.namespaceInstanceService.findInstance(instanceId);
    const k8sNamespaceName = instance.k8sNamespace || `dokkimi-${instanceId}`;

    try {
      await this.namespaceInstanceService.updateInstanceStatus(
        instanceId,
        InstanceStatus.STOPPING,
      );

      await this.instanceItemService.markAllStopping(instanceId);

      await this.k8sClient.deleteNamespace(k8sNamespaceName);

      await this.namespaceInstanceService.updateInstanceStatus(
        instanceId,
        InstanceStatus.TERMINATING,
      );

      this.logger.log(`Instance ${instanceId} termination initiated`);
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
