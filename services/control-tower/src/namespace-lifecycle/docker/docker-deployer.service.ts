import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DockerClientService } from './docker-client.service';
import {
  DockerConfigService,
  InstanceConfigPaths,
} from './docker-config.service';
import { DockerCaService, CaBundlePaths } from './docker-ca.service';
import { DockerLogCollectorService } from './docker-log-collector.service';
import { DockerServiceGroupService } from './docker-service-group.service';
import { DockerDatabaseGroupService } from './docker-database-group.service';
import { DockerBrokerGroupService } from './docker-broker-group.service';
import { DockerDeployConfigService } from './docker-deploy-config.service';
import { DockerImagePullerService } from './docker-image-puller.service';
import { sanitizeContainerName } from '../../utils/name.utils';
import {
  DeploymentContext,
  DefinitionItem,
  groupItemsByStage,
} from '../deployment-context.types';
import { InstanceItemService } from '../../namespace/instance-item.service';
import { NamespaceInstanceService } from '../../namespace/namespace-instance.service';
import { hasUiSteps } from '../ui-step-detection';
import { InstanceStatus, ItemStatus } from '@prisma/client';

interface DeploymentSession {
  ctx: DeploymentContext;
  networkName: string;
  testAgentIP: string;
  dockerDnsIP: string;
  configPaths: InstanceConfigPaths;
  caBundlePaths: CaBundlePaths;
  directDnsNames: string[];
  attachChromium: boolean;
  itemStages: DefinitionItem[][];
  onCrash?: (instanceId: string) => void;
}

@Injectable()
export class DockerDeployerService {
  private readonly logger = new Logger(DockerDeployerService.name);
  private readonly crashMonitors = new Map<string, NodeJS.Timeout>();
  private readonly deploymentSessions = new Map<string, DeploymentSession>();

  constructor(
    private readonly dockerClient: DockerClientService,
    private readonly dockerConfig: DockerConfigService,
    private readonly caService: DockerCaService,
    private readonly logCollector: DockerLogCollectorService,
    private readonly serviceGroup: DockerServiceGroupService,
    private readonly databaseGroup: DockerDatabaseGroupService,
    private readonly brokerGroup: DockerBrokerGroupService,
    private readonly deployConfig: DockerDeployConfigService,
    private readonly imagePuller: DockerImagePullerService,
    private readonly instanceItemService: InstanceItemService,
    private readonly instanceService: NamespaceInstanceService,
  ) {}

  async deploy(
    ctx: DeploymentContext,
    onCrash?: (instanceId: string) => void,
  ): Promise<void> {
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

      // Pull all images across all stages upfront
      await this.imagePuller.pullAllImages(ctx, attachChromium);

      const networkName = await this.dockerClient.createNetwork(instanceId);
      const dockerDnsIP = this.dockerClient.getDockerDnsIP();

      const configPaths = this.dockerConfig.createConfigDir(instanceId);
      const caBundlePaths =
        this.caService.prepareCaBundleForInstance(instanceId);

      // DNS names for all databases/brokers across all stages
      const directDnsNames = ctx.definition.items
        .filter((i) => i.type === 'DATABASE' || i.type === 'BROKER')
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

      // Resolve test-agent IP for GELF log driver
      const testAgentInfo = await this.dockerClient.inspectContainer(
        `test-agent-${instanceId}`,
      );
      const testAgentIP = testAgentInfo?.ip;
      if (!testAgentIP) {
        throw new Error('Failed to get test-agent IP for GELF log driver');
      }

      // Group items by stage prop for staged deployment
      const itemStages = groupItemsByStage(ctx.definition.items);

      // Store deployment session for subsequent stage deployments
      const session: DeploymentSession = {
        ctx,
        networkName,
        testAgentIP,
        dockerDnsIP,
        configPaths,
        caBundlePaths,
        directDnsNames,
        attachChromium,
        itemStages,
        onCrash,
      };
      this.deploymentSessions.set(instanceId, session);

      // Deploy stage 0 items
      const isFinalStage = itemStages.length <= 1;
      await this.deployStageItems(session, 0);

      if (isFinalStage) {
        await this.instanceService.updateInstanceStatus(
          instanceId,
          InstanceStatus.RUNNING,
        );
      }

      this.monitorForCrashedContainers(instanceId, onCrash);

      this.logger.log(
        `Docker deployment complete for instance ${instanceId} (stage 0/${itemStages.length - 1})`,
      );
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

  async deployStage(instanceId: string, stage: number): Promise<void> {
    const session = this.deploymentSessions.get(instanceId);
    if (!session) {
      throw new BadRequestException(
        `No deployment session for instance ${instanceId}`,
      );
    }

    const { ctx, itemStages } = session;
    if (stage < 0 || stage >= itemStages.length) {
      throw new BadRequestException(
        `Invalid stage ${stage} — definition has ${itemStages.length} stages`,
      );
    }

    // Idempotent: check if items in this stage are already deployed
    const stageItems = itemStages[stage];
    const stageItemIds = new Set(
      stageItems.map((i) => ctx.instanceItemIds.get(i.name)).filter(Boolean),
    );
    if (stageItemIds.size > 0) {
      const allInstanceItems =
        await this.instanceItemService.findInstanceItems(instanceId);
      const alreadyDeployed = allInstanceItems
        .filter((ii) => stageItemIds.has(ii.id))
        .every((ii) => ii.status !== 'PENDING');
      if (alreadyDeployed) {
        this.logger.log(
          `Stage ${stage} already deployed for instance ${instanceId}`,
        );
        return;
      }
    }

    try {
      await this.deployStageItems(session, stage);

      // Set RUNNING on final stage
      if (stage === itemStages.length - 1) {
        await this.instanceService.updateInstanceStatus(
          instanceId,
          InstanceStatus.RUNNING,
        );
      }

      this.logger.log(`Stage ${stage} deployed for instance ${instanceId}`);
    } catch (err) {
      this.logger.error(
        `Stage ${stage} deployment failed for instance ${instanceId}:`,
        err,
      );
      try {
        await this.teardown(instanceId);
      } catch (cleanupErr) {
        this.logger.warn(`Teardown after failed stage deploy:`, cleanupErr);
      }
      await this.instanceService.updateInstanceStatus(
        instanceId,
        InstanceStatus.FAILED,
      );
      throw err;
    }
  }

  private async deployStageItems(
    session: DeploymentSession,
    stageIndex: number,
  ): Promise<void> {
    const {
      ctx,
      networkName,
      testAgentIP,
      dockerDnsIP,
      configPaths,
      caBundlePaths,
      directDnsNames,
      attachChromium,
    } = session;
    const instanceId = ctx.instanceId;
    const stageItems = session.itemStages[stageIndex] || [];

    // Phase: databases first (within this stage)
    const dbItems = stageItems.filter((i) => i.type === 'DATABASE');
    if (dbItems.length > 0) {
      const dbResults = await Promise.allSettled(
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
      this.throwOnSettledErrors(dbResults);
    }

    // Phase: brokers second
    const brokerItems = stageItems.filter((i) => i.type === 'BROKER');
    if (brokerItems.length > 0) {
      const brokerResults = await Promise.allSettled(
        brokerItems.map(async (item) => {
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

          await this.brokerGroup.createBrokerGroup(
            networkName,
            instanceId,
            item,
            containerName,
            instanceItemId || '',
          );

          const brokerProxyName = `${containerName}-brokerproxy-${instanceId}`;
          await this.logCollector.startCollecting(
            instanceId,
            brokerProxyName,
            `${item.name}-brokerproxy`,
            undefined,
          );
        }),
      );
      this.throwOnSettledErrors(brokerResults);
    }

    // Phase: workers third (deploy with interceptor, mark READY immediately)
    const workerItems = stageItems.filter((i) => i.type === 'WORKER');
    if (workerItems.length > 0) {
      const workerResults = await Promise.allSettled(
        workerItems.map(async (item) => {
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

          const { userContainerId } =
            await this.serviceGroup.createServiceGroup(
              networkName,
              instanceId,
              item,
              containerName,
              instanceItemId,
              dockerDnsIP,
              configPaths,
              caBundlePaths,
              directDnsNames,
              testAgentIP,
            );

          if (instanceItemId && userContainerId) {
            await this.instanceItemService.updateInstanceItemStatus(
              instanceItemId,
              ItemStatus.RUNNING,
            );
            await this.instanceItemService.updateInstanceItemReadiness(
              instanceItemId,
              'READY',
            );
          }
        }),
      );
      this.throwOnSettledErrors(workerResults);
    }

    // Phase: services fourth
    const svcItems = stageItems.filter((i) => i.type === 'SERVICE');
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

      await this.serviceGroup.createServiceGroup(
        networkName,
        instanceId,
        item,
        containerName,
        instanceItemId,
        dockerDnsIP,
        configPaths,
        caBundlePaths,
        directDnsNames,
        testAgentIP,
      );
    });

    // Chromium deploys with the final stage — keep in sync with docker-deploy-config.service.ts (expectedItemStages)
    const isFinalStage = stageIndex === session.itemStages.length - 1;
    const chromiumItemId = ctx.instanceItemIds.get('chromium');
    const chromiumPromise =
      isFinalStage && attachChromium
        ? this.serviceGroup.createChromiumGroup(
            networkName,
            instanceId,
            dockerDnsIP,
            configPaths,
            caBundlePaths,
            directDnsNames,
            chromiumItemId || 'chromium',
            ctx.definition.config?.browser,
          )
        : Promise.resolve();

    if (servicePromises.length > 0 || (isFinalStage && attachChromium)) {
      const svcResults = await Promise.allSettled([
        ...servicePromises,
        chromiumPromise,
      ]);
      this.throwOnSettledErrors(svcResults);
    }
  }

  private monitorForCrashedContainers(
    instanceId: string,
    onCrash?: (instanceId: string) => void,
  ): void {
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
          (c) =>
            c.role === 'service' ||
            c.role === 'worker' ||
            c.role === 'database',
        );
        if (crashedServices.length > 0) {
          this.clearCrashMonitor(instanceId);
          const names = crashedServices.map((c) => c.name).join(', ');
          const errorMsg = `Container(s) crashed: ${names}`;
          this.logger.error(`${errorMsg} (instance ${instanceId})`);

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
            if (onCrash) {
              onCrash(instanceId);
            }
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
    this.deploymentSessions.delete(instanceId);
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
