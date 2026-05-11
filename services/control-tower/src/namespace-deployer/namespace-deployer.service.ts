import { Injectable, Logger } from '@nestjs/common';
import { TelemetryService } from '../telemetry/telemetry.service';
import { InstanceStatus, ItemStatus } from '@prisma/client';
import { KubernetesClientService } from '../namespace-lifecycle/kubernetes/kubernetes-client.service';
import { InterceptorCreatorService } from '../namespace-lifecycle/resource-creators/interceptor-creator.service';
import { ServiceInterceptorCreatorService } from '../namespace-lifecycle/resource-creators/service-interceptor-creator.service';
import { TestAgentCreatorService } from '../namespace-lifecycle/resource-creators/test-agent-creator.service';
import { ChromiumCreatorService } from '../namespace-lifecycle/resource-creators/chromium-creator.service';
import {
  InstanceItemCreatorService,
  DeployableItem,
} from '../namespace-lifecycle/resource-creators/instance-item-creator.service';
import { InstanceItemService } from '../namespace/instance-item.service';
import { NamespaceInstanceService } from '../namespace/namespace-instance.service';
import { sanitizeK8sName } from '../utils/k8s.utils';
import { DeployerConfigMapService } from './deployer-configmap.service';
import { DeploymentContext, DefinitionItem } from './deployment-context.types';
import { DokkimiCaService } from '../namespace-lifecycle/dokkimi-ca.service';
import { RegistryCredentialsService } from '../namespace-lifecycle/registry-credentials.service';
import { hasUiSteps } from './ui-step-detection';

@Injectable()
export class NamespaceDeployerService {
  private readonly logger = new Logger(NamespaceDeployerService.name);

  constructor(
    private readonly k8sClient: KubernetesClientService,
    private readonly interceptorCreator: InterceptorCreatorService,
    private readonly serviceInterceptorCreator: ServiceInterceptorCreatorService,
    private readonly testAgentCreator: TestAgentCreatorService,
    private readonly chromiumCreator: ChromiumCreatorService,
    private readonly instanceItemCreator: InstanceItemCreatorService,
    private readonly instanceItemService: InstanceItemService,
    private readonly instanceService: NamespaceInstanceService,
    private readonly deployerConfigMap: DeployerConfigMapService,
    private readonly caService: DokkimiCaService,
    private readonly registryCredentials: RegistryCredentialsService,
    private readonly telemetry: TelemetryService,
  ) {}

  async deploy(ctx: DeploymentContext): Promise<void> {
    const deployStart = Date.now();
    const attachChromium = hasUiSteps(ctx.definition);
    try {
      // 1. Compute k8sNames and derived state
      // (Init files are already on disk — written during submitInstance)
      const serviceItems = ctx.definition.items.filter(
        (item) => item.type === 'SERVICE',
      );
      const allServiceNames = serviceItems.map((item) =>
        sanitizeK8sName(item.name),
      );
      const allServicePorts = serviceItems
        .map((item) => item.port)
        .filter((p): p is number => p != null);
      const databaseNames = ctx.definition.items
        .filter((item) => item.type === 'DATABASE')
        .map((item) => sanitizeK8sName(item.name));

      // 3. Update instance: STARTING
      await this.instanceService.updateInstanceStatus(
        ctx.instanceId,
        InstanceStatus.STARTING,
      );
      await this.instanceService.updateInstanceK8sNamespace(
        ctx.instanceId,
        ctx.k8sNamespaceName,
      );

      // 4. Create K8s namespace
      await this.k8sClient.createNamespace(ctx.k8sNamespaceName);
      await this.caService.copyCAToNamespace(ctx.k8sNamespaceName);

      // 5. Get kube-dns ClusterIP
      const k8sDnsIP = await this.k8sClient.getKubeDnsClusterIP();

      // 6. Build and apply configmap
      await this.deployerConfigMap.buildAndApply(ctx);

      // 7. Mark mock items
      await this.markMockItems(ctx);

      // 8. Create global interceptor
      await this.interceptorCreator.create(
        ctx.k8sNamespaceName,
        ctx.instanceId,
        k8sDnsIP,
      );

      // 8b. Copy registry credentials into namespace (must happen after step 8
      // creates the interceptor-service-account that user pods use)
      await this.registryCredentials.copyToNamespace(
        ctx.runId,
        ctx.k8sNamespaceName,
      );

      // 9. Deploy test-agent — chromium flag determines BROWSER_URL.
      await this.testAgentCreator.create(ctx.k8sNamespaceName, ctx.instanceId, {
        hasUiSteps: attachChromium,
      });

      // 10. Deploy non-mock items
      for (const item of ctx.definition.items) {
        if (item.type === 'MOCK') {
          continue;
        }

        const instanceItemId = ctx.instanceItemIds.get(item.name);
        if (!instanceItemId) {
          this.logger.warn(
            `No instanceItemId for item "${item.name}", skipping`,
          );
          continue;
        }

        const k8sName = sanitizeK8sName(item.name);

        // Set k8sName and status -> STARTING
        await this.instanceItemService.updateInstanceItemK8sName(
          instanceItemId,
          k8sName,
        );
        await this.instanceItemService.updateInstanceItemStatus(
          instanceItemId,
          ItemStatus.STARTING,
        );

        const deployableItem = this.toDeployableItem(item, k8sName);

        if (item.type === 'SERVICE') {
          const { clusterIP } = await this.serviceInterceptorCreator.create(
            ctx.k8sNamespaceName,
            ctx.instanceId,
            deployableItem,
            instanceItemId,
            k8sDnsIP,
            allServicePorts,
          );
          await this.instanceItemCreator.createService(
            ctx.k8sNamespaceName,
            ctx.instanceId,
            deployableItem,
            k8sDnsIP,
            instanceItemId,
            clusterIP,
            allServiceNames,
            databaseNames,
          );
        } else if (item.type === 'DATABASE') {
          await this.instanceItemCreator.createDatabase(
            ctx.k8sNamespaceName,
            ctx.instanceId,
            deployableItem,
            instanceItemId,
          );
        }
      }

      // 11. Create standalone chromium pod with its own interceptor and
      //     dnsmasq — same pattern as every other service pod.
      if (attachChromium) {
        const chromiumStart = Date.now();
        await this.chromiumCreator.create({
          k8sNamespace: ctx.k8sNamespaceName,
          instanceId: ctx.instanceId,
          k8sDnsIP,
          allServiceNames,
          allServicePorts,
          databaseNames,
          browser: ctx.definition.config?.browser,
        });
        this.telemetry.track('ct_chromium_deployed', {
          duration_ms: Date.now() - chromiumStart,
          browser_version: ctx.definition.config?.browser?.version ?? 'default',
        });
      }

      // 12. Update instance: RUNNING
      await this.instanceService.updateInstanceStatus(
        ctx.instanceId,
        InstanceStatus.RUNNING,
      );

      this.logger.log(`Instance ${ctx.instanceId} deployed successfully`);
    } catch (err) {
      this.telemetry.track('ct_deploy_failed', {
        duration_ms: Date.now() - deployStart,
        error_type: err instanceof Error ? err.constructor.name : 'Unknown',
        has_ui_steps: attachChromium,
      });
      this.logger.error(
        `Deployment failed for instance ${ctx.instanceId}:`,
        err,
      );
      await this.instanceService.updateInstanceStatus(
        ctx.instanceId,
        InstanceStatus.FAILED,
      );
      throw err;
    }
  }

  // ============================================
  // PRIVATE
  // ============================================

  private async markMockItems(ctx: DeploymentContext): Promise<void> {
    for (const item of ctx.definition.items) {
      if (item.type !== 'MOCK') {
        continue;
      }

      const instanceItemId = ctx.instanceItemIds.get(item.name);
      if (!instanceItemId) {
        continue;
      }

      const k8sName = sanitizeK8sName(item.name);
      await this.instanceItemService.updateInstanceItemK8sName(
        instanceItemId,
        k8sName,
      );
      await this.instanceItemService.updateInstanceItemStatus(
        instanceItemId,
        ItemStatus.STARTING,
      );
      await this.instanceItemService.updateInstanceItemReadiness(
        instanceItemId,
        'READY',
      );
    }
  }

  private toDeployableItem(
    item: DefinitionItem,
    k8sName: string,
  ): DeployableItem {
    return {
      ...item,
      k8sName,
    } as DeployableItem;
  }
}
