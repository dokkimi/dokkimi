import { Injectable, Logger } from '@nestjs/common';
import { DockerClientService } from './docker-client.service';
import { DockerConfigService } from './docker-config.service';
import { DockerCaService } from './docker-ca.service';
import { DockerLogCollectorService } from './docker-log-collector.service';
import { DockerServiceGroupService } from './docker-service-group.service';
import { DockerDatabaseGroupService } from './docker-database-group.service';
import { DockerDeployConfigService } from './docker-deploy-config.service';
import { DockerImagePullerService } from './docker-image-puller.service';
import { sanitizeContainerName } from '../../utils/name.utils';
import { DeploymentContext } from '../deployment-context.types';
import { InstanceItemService } from '../../namespace/instance-item.service';
import { NamespaceInstanceService } from '../../namespace/namespace-instance.service';
import { hasUiSteps } from '../ui-step-detection';
import { InstanceStatus, ItemStatus } from '@prisma/client';

@Injectable()
export class DockerDeployerService {
  private readonly logger = new Logger(DockerDeployerService.name);
  private readonly crashMonitors = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly dockerClient: DockerClientService,
    private readonly dockerConfig: DockerConfigService,
    private readonly caService: DockerCaService,
    private readonly logCollector: DockerLogCollectorService,
    private readonly serviceGroup: DockerServiceGroupService,
    private readonly databaseGroup: DockerDatabaseGroupService,
    private readonly deployConfig: DockerDeployConfigService,
    private readonly imagePuller: DockerImagePullerService,
    private readonly instanceItemService: InstanceItemService,
    private readonly instanceService: NamespaceInstanceService,
  ) {}

  async deploy(ctx: DeploymentContext): Promise<void> {
    const instanceId = ctx.instanceId;
    const attachChromium = hasUiSteps(ctx.definition);

    try {
      await this.instanceService.updateInstanceStatus(
        instanceId,
        InstanceStatus.STARTING,
      );
      await this.instanceService.updateInstanceDockerNetwork(
        instanceId,
        `dokkimi-${instanceId}`,
      );

      await this.markMockItems(ctx);

      await this.imagePuller.pullAllImages(ctx, attachChromium);

      const networkName = await this.dockerClient.createNetwork(instanceId);
      const dockerDnsIP = this.dockerClient.getDockerDnsIP();

      const configPaths = this.dockerConfig.createConfigDir(instanceId);
      const caBundlePaths =
        this.caService.prepareCaBundleForInstance(instanceId);

      const databaseNames = ctx.definition.items
        .filter((i) => i.type === 'DATABASE')
        .map((i) => sanitizeContainerName(i.name));

      await this.deployConfig.writeConfig(ctx, configPaths);

      // Phase 1: Global interceptor + test-agent (independent, parallel)
      const phase1Results = await Promise.allSettled([
        this.serviceGroup.createGlobalInterceptor(
          networkName,
          instanceId,
          dockerDnsIP,
          configPaths,
        ),
        this.serviceGroup.createTestAgent(
          networkName,
          instanceId,
          attachChromium,
          configPaths,
        ),
      ]);
      this.throwOnSettledErrors(phase1Results);

      // Phase 2: All databases in parallel
      const dbItems = ctx.definition.items.filter((i) => i.type === 'DATABASE');
      const phase2Results = await Promise.allSettled(
        dbItems.map(async (item) => {
          const containerName = sanitizeContainerName(item.name);
          const instanceItemId = ctx.instanceItemIds.get(item.name);

          if (instanceItemId) {
            await this.instanceItemService.updateInstanceItemContainerName(
              instanceItemId,
              containerName,
            );
            await this.instanceItemService.updateInstanceItemStatus(
              instanceItemId,
              ItemStatus.STARTING,
            );
          }

          await this.databaseGroup.createDatabaseGroup(
            networkName,
            instanceId,
            item,
            containerName,
            instanceItemId || '',
          );

          const dbProxyName = `${containerName}-dbproxy-${instanceId}`;
          await this.logCollector.startCollecting(
            instanceId,
            dbProxyName,
            `${item.name}-dbproxy`,
            undefined,
          );
        }),
      );
      this.throwOnSettledErrors(phase2Results);

      // Phase 3: All services + chromium in parallel
      const svcItems = ctx.definition.items.filter((i) => i.type === 'SERVICE');
      const servicePromises = svcItems.map(async (item) => {
        const containerName = sanitizeContainerName(item.name);
        const instanceItemId = ctx.instanceItemIds.get(item.name);

        if (instanceItemId) {
          await this.instanceItemService.updateInstanceItemContainerName(
            instanceItemId,
            containerName,
          );
          await this.instanceItemService.updateInstanceItemStatus(
            instanceItemId,
            ItemStatus.STARTING,
          );
        }

        const { userContainerId, interceptorName } =
          await this.serviceGroup.createServiceGroup(
            networkName,
            instanceId,
            item,
            containerName,
            instanceItemId,
            dockerDnsIP,
            configPaths,
            caBundlePaths,
            databaseNames,
          );
        if (userContainerId) {
          await this.logCollector.startCollecting(
            instanceId,
            userContainerId,
            item.name,
            instanceItemId,
          );
        }
        if (interceptorName) {
          await this.logCollector.startCollecting(
            instanceId,
            interceptorName,
            `${item.name}-interceptor`,
            undefined,
          );
        }
      });

      const chromiumPromise = attachChromium
        ? this.serviceGroup.createChromiumGroup(
            networkName,
            instanceId,
            dockerDnsIP,
            configPaths,
            caBundlePaths,
            databaseNames,
            ctx.definition.config?.browser,
          )
        : Promise.resolve();

      const phase3Results = await Promise.allSettled([
        ...servicePromises,
        chromiumPromise,
      ]);
      this.throwOnSettledErrors(phase3Results);

      await this.instanceService.updateInstanceStatus(
        instanceId,
        InstanceStatus.RUNNING,
      );

      this.monitorForCrashedContainers(instanceId);

      this.logger.log(`Docker deployment complete for instance ${instanceId}`);
    } catch (err) {
      this.logger.error(`Deployment failed for instance ${instanceId}:`, err);
      try {
        await this.teardown(instanceId);
      } catch (cleanupErr) {
        this.logger.warn(`Teardown after failed deploy:`, cleanupErr);
      }
      await this.instanceService.updateInstanceStatus(
        instanceId,
        InstanceStatus.FAILED,
      );
      throw err;
    }
  }

  private monitorForCrashedContainers(instanceId: string): void {
    const checkInterval = setInterval(async () => {
      try {
        const instance = await this.instanceService.findInstance(instanceId);
        if (
          !instance ||
          instance.status === 'STOPPED' ||
          instance.status === 'FAILED'
        ) {
          this.clearCrashMonitor(instanceId);
          return;
        }

        const exited = await this.dockerClient.getExitedContainers(instanceId);
        const crashedServices = exited.filter(
          (c) => c.role === 'service' || c.role === 'database',
        );
        if (crashedServices.length > 0) {
          this.clearCrashMonitor(instanceId);
          const names = crashedServices.map((c) => c.name).join(', ');
          const errorMsg = `Container(s) crashed: ${names}`;
          this.logger.error(`${errorMsg} (instance ${instanceId})`);

          // Only set FAILED if instance is still in an active state
          const current = await this.instanceService.findInstance(instanceId);
          if (
            current &&
            current.status !== 'STOPPED' &&
            current.status !== 'FAILED'
          ) {
            await this.instanceService.updateInstanceStatus(
              instanceId,
              InstanceStatus.FAILED,
            );
            await this.teardown(instanceId);
          }
        }
      } catch {
        this.clearCrashMonitor(instanceId);
      }
    }, 3000);
    this.crashMonitors.set(instanceId, checkInterval);
  }

  private clearCrashMonitor(instanceId: string): void {
    const interval = this.crashMonitors.get(instanceId);
    if (interval) {
      clearInterval(interval);
      this.crashMonitors.delete(instanceId);
    }
  }

  async teardown(instanceId: string): Promise<void> {
    this.clearCrashMonitor(instanceId);
    this.logCollector.stopCollecting(instanceId);
    await this.dockerClient.removeNetwork(instanceId);
    this.dockerConfig.cleanupConfigDir(instanceId);
    this.logger.log(`Teardown complete for instance ${instanceId}`);
  }

  private throwOnSettledErrors(results: PromiseSettledResult<unknown>[]): void {
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason);
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      const messages = errors.map((e) =>
        e instanceof Error ? e.message : String(e),
      );
      throw new Error(
        `${errors.length} containers failed:\n${messages.join('\n')}`,
      );
    }
  }

  private async markMockItems(ctx: DeploymentContext): Promise<void> {
    for (const item of ctx.definition.items) {
      if (item.type !== 'MOCK') {
        continue;
      }

      const instanceItemId = ctx.instanceItemIds.get(item.name);
      if (!instanceItemId) {
        continue;
      }

      const containerName = sanitizeContainerName(item.name);
      await this.instanceItemService.updateInstanceItemContainerName(
        instanceItemId,
        containerName,
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
}
