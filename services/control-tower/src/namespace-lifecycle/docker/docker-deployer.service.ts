import * as fs from 'fs';
import { Injectable, Logger } from '@nestjs/common';
import {
  getConfig,
  buildInterceptorEnvVars,
  buildTestAgentEnvVars,
  buildDbProxyEnvVars,
} from '@dokkimi/config';
import {
  DockerClientService,
  RunContainerOptions,
} from './docker-client.service';
import {
  DockerConfigService,
  InstanceConfigPaths,
} from './docker-config.service';
import { DockerCaService, CaBundlePaths } from './docker-ca.service';
import { DockerLogCollectorService } from './docker-log-collector.service';
import {
  DOKKIMI_IMAGES,
  resolveBrowserImage,
} from '../../constants/image-tags';
import { sanitizeK8sName } from '../../utils/k8s.utils';
import {
  DeploymentContext,
  DefinitionItem,
  BrowserConfig,
} from '../../namespace-deployer/deployment-context.types';
import { DatabaseConfigService } from '../builders/database-config.service';
import { DockerRegistryService } from './docker-registry.service';
import { InstanceItemService } from '../../namespace/instance-item.service';
import { NamespaceInstanceService } from '../../namespace/namespace-instance.service';
import { RunStorageService } from '../../storage/run-storage.service';
import { hasUiSteps } from '../../namespace-deployer/ui-step-detection';
import { InstanceStatus, ItemStatus } from '@prisma/client';

@Injectable()
export class DockerDeployerService {
  private readonly logger = new Logger(DockerDeployerService.name);

  constructor(
    private readonly dockerClient: DockerClientService,
    private readonly dockerConfig: DockerConfigService,
    private readonly caService: DockerCaService,
    private readonly databaseConfig: DatabaseConfigService,
    private readonly logCollector: DockerLogCollectorService,
    private readonly registryService: DockerRegistryService,
    private readonly instanceItemService: InstanceItemService,
    private readonly instanceService: NamespaceInstanceService,
    private readonly runStorage: RunStorageService,
  ) {}

  async deploy(ctx: DeploymentContext): Promise<void> {
    const instanceId = ctx.instanceId;
    const attachChromium = hasUiSteps(ctx.definition);

    try {
      await this.instanceService.updateInstanceStatus(
        instanceId,
        InstanceStatus.STARTING,
      );
      await this.instanceService.updateInstanceK8sNamespace(
        instanceId,
        `dokkimi-${instanceId}`,
      );

      await this.markMockItems(ctx);

      await this.pullAllImages(ctx, attachChromium);

      const networkName = await this.dockerClient.createNetwork(instanceId);
      const dockerDnsIP = this.dockerClient.getDockerDnsIP();

      const configPaths = this.dockerConfig.createConfigDir(instanceId);
      const caBundlePaths =
        this.caService.prepareCaBundleForInstance(instanceId);

      const serviceItems = ctx.definition.items.filter(
        (i) => i.type === 'SERVICE',
      );
      const allServiceNames = serviceItems.map((i) => sanitizeK8sName(i.name));
      const allServicePorts = serviceItems
        .map((i) => i.port)
        .filter((p): p is number => p != null);
      const databaseNames = ctx.definition.items
        .filter((i) => i.type === 'DATABASE')
        .map((i) => sanitizeK8sName(i.name));

      await this.writeConfig(ctx, configPaths);

      // Phase 1: Global interceptor + test-agent (independent, parallel)
      await Promise.all([
        this.createGlobalInterceptor(
          networkName,
          instanceId,
          dockerDnsIP,
          configPaths,
        ),
        this.createTestAgent(
          networkName,
          instanceId,
          attachChromium,
          configPaths,
        ),
      ]);

      // Phase 2: All databases in parallel
      const dbItems = ctx.definition.items.filter((i) => i.type === 'DATABASE');
      const phase2Results = await Promise.allSettled(
        dbItems.map(async (item) => {
          const containerName = sanitizeK8sName(item.name);
          const instanceItemId = ctx.instanceItemIds.get(item.name);

          if (instanceItemId) {
            await this.instanceItemService.updateInstanceItemK8sName(
              instanceItemId,
              containerName,
            );
            await this.instanceItemService.updateInstanceItemStatus(
              instanceItemId,
              ItemStatus.STARTING,
            );
          }

          await this.createDatabaseGroup(
            networkName,
            instanceId,
            item,
            containerName,
            instanceItemId || '',
          );
        }),
      );
      const phase2Error = phase2Results.find(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult | undefined;
      if (phase2Error) {
        throw phase2Error.reason;
      }

      // Phase 3: All services + chromium in parallel
      // Use allSettled so that if one container fails, we don't tear down the
      // network while other containers are still starting (which causes
      // cascading "network not found" errors).
      const svcItems = ctx.definition.items.filter((i) => i.type === 'SERVICE');
      const servicePromises = svcItems.map(async (item) => {
        const containerName = sanitizeK8sName(item.name);
        const instanceItemId = ctx.instanceItemIds.get(item.name);

        if (instanceItemId) {
          await this.instanceItemService.updateInstanceItemK8sName(
            instanceItemId,
            containerName,
          );
          await this.instanceItemService.updateInstanceItemStatus(
            instanceItemId,
            ItemStatus.STARTING,
          );
        }

        const { userContainerId, interceptorName } =
          await this.createServiceGroup(
            networkName,
            instanceId,
            item,
            containerName,
            instanceItemId,
            dockerDnsIP,
            configPaths,
            caBundlePaths,
            allServiceNames,
            allServicePorts,
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
        ? this.createChromiumGroup(
            networkName,
            instanceId,
            dockerDnsIP,
            configPaths,
            caBundlePaths,
            allServiceNames,
            allServicePorts,
            databaseNames,
            ctx.definition.config?.browser,
          )
        : Promise.resolve();

      const phase3Results = await Promise.allSettled([
        ...servicePromises,
        chromiumPromise,
      ]);
      const phase3Error = phase3Results.find(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult | undefined;
      if (phase3Error) {
        throw phase3Error.reason;
      }

      await this.instanceService.updateInstanceStatus(
        instanceId,
        InstanceStatus.RUNNING,
      );

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

  async teardown(instanceId: string): Promise<void> {
    this.logCollector.stopCollecting(instanceId);
    await this.dockerClient.removeNetwork(instanceId);
    this.dockerConfig.cleanupConfigDir(instanceId);
    this.logger.log(`Teardown complete for instance ${instanceId}`);
  }

  // ============================================
  // CONFIG
  // ============================================

  private async writeConfig(
    ctx: DeploymentContext,
    configPaths: InstanceConfigPaths,
  ): Promise<void> {
    const items = ctx.definition.items;
    const itemsWithK8sName = items.map((item) => ({
      ...item,
      k8sName: sanitizeK8sName(item.name),
      id: ctx.instanceItemIds.get(item.name),
    }));

    const mocks = items
      .filter((item) => item.type === 'MOCK')
      .map((mock) => {
        let responseBody: string | undefined;
        if (
          mock.mockResponseBody !== null &&
          mock.mockResponseBody !== undefined
        ) {
          responseBody =
            typeof mock.mockResponseBody === 'string'
              ? mock.mockResponseBody
              : JSON.stringify(mock.mockResponseBody);
        }
        let responseHeaders: string | undefined;
        if (
          mock.mockResponseHeaders !== null &&
          mock.mockResponseHeaders !== undefined
        ) {
          responseHeaders = JSON.stringify(mock.mockResponseHeaders);
        }
        return {
          method: mock.mockMethod || '*',
          origin: mock.mockOrigin || '',
          target: mock.mockTarget || '*',
          path: mock.mockPath || '*',
          requestBodyContains: mock.mockRequestBodyContains ?? undefined,
          requestBodyMatches: mock.mockRequestBodyMatches ?? undefined,
          delayMS: mock.mockDelayMs ?? undefined,
          responseStatus: mock.mockResponseStatus ?? undefined,
          responseHeaders,
          responseBody,
        };
      });

    let testConfig:
      | {
          testRunId: string;
          timeoutSeconds: number;
          executionMode: string;
          tests: Record<string, unknown>[];
          variables?: Record<string, string>;
        }
      | undefined;
    let expectedNamespaceItemIds: string[] | undefined;

    if (ctx.definition.tests?.length) {
      const strippedTests = ctx.definition.tests.map((test) => ({
        ...test,
        steps: (test.steps ?? []).map((step) => {
          const { assertions: _assertions, ...executionOnly } =
            step as unknown as Record<string, unknown> & {
              assertions?: unknown;
            };
          return executionOnly;
        }),
      }));

      testConfig = {
        testRunId: ctx.instanceId,
        timeoutSeconds: ctx.definition.config?.timeoutSeconds || 300,
        executionMode: 'auto',
        tests: strippedTests,
        variables: ctx.definition.variables,
      };

      expectedNamespaceItemIds = items
        .filter((item) => item.type !== 'MOCK')
        .map((item) => ctx.instanceItemIds.get(item.name))
        .filter((id): id is string => id !== undefined);

      if (hasUiSteps(ctx.definition)) {
        expectedNamespaceItemIds.push('chromium');
      }
    }

    this.dockerConfig.writeInterceptorConfig(
      configPaths,
      itemsWithK8sName as any,
      mocks,
      ctx.instanceId,
      testConfig,
      expectedNamespaceItemIds,
    );
  }

  // ============================================
  // GLOBAL INTERCEPTOR
  // ============================================

  private async createGlobalInterceptor(
    networkName: string,
    instanceId: string,
    dockerDnsIP: string,
    configPaths: InstanceConfigPaths,
  ): Promise<void> {
    const config = getConfig();
    const envEntries = buildInterceptorEnvVars(config, {
      namespace: instanceId,
      k8sNamespace: networkName,
      apiKey: 'dokkimi-interceptor-key',
      k8sDnsIP: dockerDnsIP,
      origin: '',
    });

    await this.dockerClient.runContainer({
      name: `interceptor-${instanceId}`,
      image: DOKKIMI_IMAGES.interceptor,
      networkName,
      networkAliases: ['interceptor-service'],
      env: {
        ...this.envArrayToRecord(envEntries),
        ...this.caService.getInterceptorCaEnvVars(),
        DEPLOY_MODE: 'docker',
        CONFIG_FILE_PATH: '/etc/dokkimi/config.json',
      },
      binds: [
        `${configPaths.configJsonPath}:/etc/dokkimi/config.json:ro`,
        ...this.caService.getInterceptorCaBinds(),
      ],
      exposedPorts: [config.services.interceptor.port],
      labels: {
        'io.dokkimi.instance-id': instanceId,
        'io.dokkimi.role': 'interceptor',
      },
    });
  }

  // ============================================
  // TEST AGENT
  // ============================================

  private async createTestAgent(
    networkName: string,
    instanceId: string,
    hasUi: boolean,
    configPaths: InstanceConfigPaths,
  ): Promise<void> {
    const config = getConfig();
    const envEntries = buildTestAgentEnvVars(config, {
      k8sNamespace: networkName,
      browserURL: hasUi
        ? `http://chromium:${config.services.chromium.port}`
        : undefined,
      defaultViewportWidth: config.browser?.defaultViewportWidth,
      defaultViewportHeight: config.browser?.defaultViewportHeight,
    });

    // Override K8s-specific env vars for Docker
    const env = this.envArrayToRecord(envEntries);
    env.INTERCEPTOR_URL = `http://interceptor-service:${config.services.interceptor.port}`;
    env.CONFIG_SOURCE = 'file';
    env.CONFIG_FILE_PATH = '/etc/dokkimi/config.json';

    await this.dockerClient.runContainer({
      name: `test-agent-${instanceId}`,
      image: DOKKIMI_IMAGES.testAgent,
      networkName,
      networkAliases: ['test-agent-service'],
      env,
      binds: [`${configPaths.configJsonPath}:/etc/dokkimi/config.json:ro`],
      exposedPorts: [config.services.testAgent.port],
      labels: {
        'io.dokkimi.instance-id': instanceId,
        'io.dokkimi.role': 'test-agent',
      },
    });
  }

  // ============================================
  // SERVICE GROUP (interceptor + dnsmasq + user container)
  // ============================================

  private async createServiceGroup(
    networkName: string,
    instanceId: string,
    item: DefinitionItem,
    containerName: string,
    instanceItemId: string | undefined,
    dockerDnsIP: string,
    configPaths: InstanceConfigPaths,
    caBundlePaths: CaBundlePaths,
    allServiceNames: string[],
    allServicePorts: number[],
    databaseNames: string[],
  ): Promise<{ userContainerId: string | null; interceptorName: string }> {
    if (!item.image) {
      this.logger.warn(`Skipping service ${item.name} — no image specified`);
      return { userContainerId: null, interceptorName: '' };
    }

    const config = getConfig();

    // 1. Start per-service interceptor (standalone container on the network, own IP)
    const interceptorName = `${containerName}-interceptor-${instanceId}`;
    const interceptorEnv = buildInterceptorEnvVars(config, {
      namespace: instanceId,
      k8sNamespace: networkName,
      apiKey: 'dokkimi-interceptor-key',
      k8sDnsIP: dockerDnsIP,
      origin: item.name,
      instanceItemName: item.name,
      healthCheckEndpoint: item.healthCheck || undefined,
      servicePort: item.port?.toString() || '80',
      namespaceItemId: instanceItemId,
      testAgentUrl: `http://test-agent-service:${config.services.testAgent.port}`,
    });

    await this.dockerClient.runContainer({
      name: interceptorName,
      image: DOKKIMI_IMAGES.interceptor,
      networkName,
      env: {
        ...this.envArrayToRecord(interceptorEnv),
        ...this.caService.getInterceptorCaEnvVars(),
        DEPLOY_MODE: 'docker',
        CONFIG_FILE_PATH: '/etc/dokkimi/config.json',
      },
      binds: [
        `${configPaths.configJsonPath}:/etc/dokkimi/config.json:ro`,
        ...this.caService.getInterceptorCaBinds(),
      ],
      exposedPorts: [config.services.interceptor.port, 443],
      labels: {
        'io.dokkimi.instance-id': instanceId,
        'io.dokkimi.role': 'service-interceptor',
        'io.dokkimi.item-name': item.name,
      },
    });

    // 2. Inspect interceptor to get its Docker network IP for dnsmasq config
    const interceptorInfo =
      await this.dockerClient.inspectContainer(interceptorName);
    const interceptorIP = interceptorInfo?.ip;
    if (!interceptorIP) {
      throw new Error(`Failed to get IP for interceptor ${interceptorName}`);
    }

    // 3. Build and write dnsmasq config routing all DNS to interceptor's IP
    const dnsmasqConf = this.buildDnsmasqConfig(
      containerName,
      dockerDnsIP,
      databaseNames,
      interceptorIP,
    );
    const dnsmasqConfPath = this.dockerConfig.writeDnsmasqConfig(
      configPaths,
      containerName,
      dnsmasqConf,
    );

    // 4. Start user's service container (primary — holds network alias)
    const userContainerName = `${containerName}-${instanceId}`;
    const userEnv: Record<string, string> = {
      ...this.caService.getServiceCaEnvVars(),
      HOSTNAME: '0.0.0.0',
    };

    // Add user-defined env vars (override defaults)
    if (item.env) {
      if (Array.isArray(item.env)) {
        for (const e of item.env as Array<{ name: string; value: string }>) {
          if (e.name) {
            userEnv[e.name] = String(e.value ?? '');
          }
        }
      } else {
        for (const [k, v] of Object.entries(item.env)) {
          userEnv[k] = String(v ?? '');
        }
      }
    }

    const userBinds = [
      ...this.caService.getServiceCaBinds(caBundlePaths),
      `${configPaths.resolvConfPath}:/etc/resolv.conf:ro`,
      ...(item.localDevPath && item.mountPath
        ? [`${item.localDevPath}:${item.mountPath}`]
        : []),
    ];

    const userContainerId = await this.dockerClient.runContainer({
      name: userContainerName,
      image: item.image,
      networkName,
      networkAliases: [containerName],
      env: userEnv,
      binds: userBinds,
      exposedPorts: [
        ...(item.port ? [item.port] : []),
        ...(item.debugPort ? [item.debugPort] : []),
      ],
      labels: {
        'io.dokkimi.instance-id': instanceId,
        'io.dokkimi.role': 'service',
        'io.dokkimi.item-name': item.name,
      },
    });

    // 5. Start dnsmasq (joins user container's network namespace)
    const dnsmasqName = `${containerName}-dnsmasq-${instanceId}`;
    await this.dockerClient.runContainer({
      name: dnsmasqName,
      image: DOKKIMI_IMAGES.dnsmasq,
      networkName,
      networkMode: `container:${userContainerName}`,
      cmd: ['-k'],
      binds: [`${dnsmasqConfPath}:/etc/dnsmasq.conf:ro`],
      labels: {
        'io.dokkimi.instance-id': instanceId,
        'io.dokkimi.role': 'dnsmasq',
        'io.dokkimi.item-name': item.name,
      },
    });

    this.logger.log(
      `Service group ${item.name}: interceptor=${interceptorInfo.state} ip=${interceptorIP}, user=${userContainerName}`,
    );

    this.logger.log(`Created service group for ${item.name}`);
    return { userContainerId, interceptorName };
  }

  // ============================================
  // DATABASE GROUP (db-proxy + database container)
  // ============================================

  private async createDatabaseGroup(
    networkName: string,
    instanceId: string,
    item: DefinitionItem,
    containerName: string,
    instanceItemId: string,
  ): Promise<void> {
    if (!item.database) {
      this.logger.warn(`Skipping database ${item.name} — no database type`);
      return;
    }

    const config = getConfig();
    const dbConfig = this.databaseConfig.getConfig(
      item.database,
      {
        dbName: item.dbName ?? undefined,
        dbUser: item.dbUser ?? undefined,
        dbPassword: item.dbPassword ?? undefined,
      },
      item.version ?? undefined,
    );

    const dbProxyImage = this.getDbProxyImage(item.database);
    const nativePort = dbConfig.ports[0];
    const internalPort = this.getDbInternalPort(item.database);
    const isMongo = item.database?.toLowerCase() === 'mongodb';

    const dbProxyName = `${containerName}-dbproxy-${instanceId}`;
    const dbContainerName = `${containerName}-db-${instanceId}`;

    const dbProxyEnvEntries = buildDbProxyEnvVars(config, {
      databaseType: item.database,
      databasePort: String(internalPort),
      instanceItemName: item.name,
      namespace: instanceId,
      namespaceItemId: instanceItemId,
      testAgentUrl: `http://test-agent-service:${config.services.testAgent.port}`,
      dbUser: item.dbUser ?? config.database.defaultUser,
      dbPassword: item.dbPassword ?? config.database.defaultPassword,
      dbName: item.dbName ?? config.database.defaultName,
    });
    const dbProxyEnv = this.envArrayToRecord(dbProxyEnvEntries);
    dbProxyEnv.QUERY_PORT = String(nativePort);

    const dbEnv: Record<string, string> = { ...dbConfig.environment };
    this.setDbInternalPortEnv(dbEnv, item.database, internalPort);

    const initFileMountPath = this.getInitFileMountPath(item.database);
    const dbBinds: string[] = [];
    if ((item.initFiles?.length || isMongo) && initFileMountPath) {
      const storageInitDir = this.runStorage.getInitFilesDir(
        instanceId,
        item.name,
      );
      if (fs.existsSync(storageInitDir)) {
        dbBinds.push(`${storageInitDir}:${initFileMountPath}:ro`);
      }
    }

    const dbCmd = this.getDbCommand(
      item.database,
      internalPort,
      dbConfig.command,
    );

    // 1. Start db-proxy (primary container, holds the network alias)
    await this.dockerClient.runContainer({
      name: dbProxyName,
      image: dbProxyImage,
      networkName,
      networkAliases: [containerName],
      env: dbProxyEnv,
      exposedPorts: [nativePort, internalPort],
      labels: {
        'io.dokkimi.instance-id': instanceId,
        'io.dokkimi.role': 'db-proxy',
        'io.dokkimi.item-name': item.name,
      },
    });

    // 2. Start database container (joins db-proxy's network namespace)
    // For MongoDB: bypass docker-entrypoint.sh which starts a temp server on
    // port 27017 (conflicting with db-proxy). Use a custom entrypoint that
    // starts mongod directly on the internal port, then runs init scripts.
    const mongoEntrypoint = isMongo
      ? this.buildMongoEntrypoint(internalPort, dbEnv, initFileMountPath)
      : undefined;

    const dbHealthcheck = this.getDatabaseHealthcheck(
      item.database,
      internalPort,
      dbEnv,
    );

    await this.dockerClient.runContainer({
      name: dbContainerName,
      image: dbConfig.image,
      networkName,
      networkMode: `container:${dbProxyName}`,
      env: dbEnv,
      binds: dbBinds,
      ...(isMongo
        ? { entrypoint: ['/bin/bash', '-c', mongoEntrypoint!], cmd: undefined }
        : dbCmd
          ? { cmd: dbCmd }
          : {}),
      healthcheck: dbHealthcheck,
      exposedPorts: [internalPort],
      labels: {
        'io.dokkimi.instance-id': instanceId,
        'io.dokkimi.role': 'database',
        'io.dokkimi.item-name': item.name,
      },
    });

    await this.dockerClient.waitForHealthy(dbContainerName, 60000, 1000);

    this.logger.log(
      `Created database group for ${item.name} (${item.database})`,
    );
  }

  private getDatabaseHealthcheck(
    databaseType: string,
    internalPort: number,
    env: Record<string, string>,
  ): RunContainerOptions['healthcheck'] | undefined {
    const dbType = databaseType.toLowerCase();
    if (dbType === 'postgres' || dbType === 'postgresql') {
      return {
        test: [
          'CMD-SHELL',
          `pg_isready -p ${internalPort} -U ${env.POSTGRES_USER || 'dokkimi'}`,
        ],
        intervalMs: 1000,
        timeoutMs: 3000,
        retries: 30,
        startPeriodMs: 1000,
      };
    }
    if (dbType === 'mysql' || dbType === 'mariadb') {
      return {
        test: [
          'CMD-SHELL',
          `mysqladmin ping -P ${internalPort} -u${env.MYSQL_USER || 'root'} -p${env.MYSQL_ROOT_PASSWORD || env.MYSQL_PASSWORD || 'dokkimi'} --silent`,
        ],
        intervalMs: 2000,
        timeoutMs: 5000,
        retries: 30,
        startPeriodMs: 5000,
      };
    }
    if (dbType === 'mongodb') {
      return {
        test: [
          'CMD-SHELL',
          `mongosh --port ${internalPort} --eval "db.adminCommand('ping')" --quiet`,
        ],
        intervalMs: 1000,
        timeoutMs: 3000,
        retries: 30,
        startPeriodMs: 2000,
      };
    }
    return undefined;
  }

  // ============================================
  // CHROMIUM GROUP
  // ============================================

  private async createChromiumGroup(
    networkName: string,
    instanceId: string,
    dockerDnsIP: string,
    configPaths: InstanceConfigPaths,
    caBundlePaths: CaBundlePaths,
    allServiceNames: string[],
    allServicePorts: number[],
    databaseNames: string[],
    browser?: BrowserConfig,
  ): Promise<void> {
    const config = getConfig();
    const chromiumPort = config.services.chromium.port;
    const browserImage = resolveBrowserImage(browser);

    // 1. Per-service interceptor for chromium
    const interceptorName = `chromium-interceptor-${instanceId}`;
    const interceptorEnv = buildInterceptorEnvVars(config, {
      namespace: instanceId,
      k8sNamespace: networkName,
      apiKey: 'dokkimi-interceptor-key',
      k8sDnsIP: dockerDnsIP,
      origin: 'chromium',
      instanceItemName: 'chromium',
      healthCheckEndpoint: '/json/version',
      servicePort: String(config.services.chromium.port),
      namespaceItemId: 'chromium',
      testAgentUrl: `http://test-agent-service:${config.services.testAgent.port}`,
    });

    // 1. Start interceptor (standalone on network, own IP)
    await this.dockerClient.runContainer({
      name: interceptorName,
      image: DOKKIMI_IMAGES.interceptor,
      networkName,
      env: {
        ...this.envArrayToRecord(interceptorEnv),
        ...this.caService.getInterceptorCaEnvVars(),
        DEPLOY_MODE: 'docker',
        CONFIG_FILE_PATH: '/etc/dokkimi/config.json',
      },
      binds: [
        `${configPaths.configJsonPath}:/etc/dokkimi/config.json:ro`,
        ...this.caService.getInterceptorCaBinds(),
      ],
      exposedPorts: [config.services.interceptor.port, 443],
      labels: {
        'io.dokkimi.instance-id': instanceId,
        'io.dokkimi.role': 'chromium-interceptor',
      },
    });

    // 2. Inspect interceptor to get its Docker network IP
    const interceptorInfo =
      await this.dockerClient.inspectContainer(interceptorName);
    const interceptorIP = interceptorInfo?.ip;
    if (!interceptorIP) {
      throw new Error(`Failed to get IP for interceptor ${interceptorName}`);
    }

    // 3. Build dnsmasq config routing all DNS to interceptor's IP
    const dnsmasqConf = this.buildDnsmasqConfig(
      'chromium',
      dockerDnsIP,
      databaseNames,
      interceptorIP,
    );
    const dnsmasqConfPath = this.dockerConfig.writeDnsmasqConfig(
      configPaths,
      'chromium',
      dnsmasqConf,
    );

    // 4. Start chromium browser (primary — holds network alias)
    const chromiumContainerName = `chromium-${instanceId}`;
    await this.dockerClient.runContainer({
      name: chromiumContainerName,
      image: browserImage,
      networkName,
      networkAliases: ['chromium'],
      cmd: ['--disable-dev-shm-usage', '--ignore-certificate-errors'],
      binds: [`${configPaths.resolvConfPath}:/etc/resolv.conf:ro`],
      exposedPorts: [chromiumPort],
      labels: {
        'io.dokkimi.instance-id': instanceId,
        'io.dokkimi.role': 'chromium',
      },
    });

    // 5. Start dnsmasq (joins chromium's network namespace)
    await this.dockerClient.runContainer({
      name: `chromium-dnsmasq-${instanceId}`,
      image: DOKKIMI_IMAGES.dnsmasq,
      networkName,
      networkMode: `container:${chromiumContainerName}`,
      cmd: ['-k'],
      binds: [`${dnsmasqConfPath}:/etc/dnsmasq.conf:ro`],
      labels: {
        'io.dokkimi.instance-id': instanceId,
        'io.dokkimi.role': 'chromium-dnsmasq',
      },
    });

    this.logger.log('Created chromium group');
  }

  // ============================================
  // DNSMASQ CONFIG
  // ============================================

  private buildDnsmasqConfig(
    serviceName: string,
    dockerDnsIP: string,
    databaseNames: string[],
    interceptorIP: string,
  ): string {
    const config = getConfig();
    const dnsNameserver = config.network.dns.nameserver;
    const lines: string[] = [];

    lines.push(`listen-address=${dnsNameserver}`);

    // Database exceptions — forward to Docker DNS (databases use TCP, not HTTP)
    for (const dbName of databaseNames) {
      lines.push(`server=/${dbName}/${dockerDnsIP}`);
    }

    // host.docker.internal must resolve via Docker DNS so the interceptor's
    // logger and health checker can reach Control Tower on the host machine.
    lines.push(`server=/host.docker.internal/${dockerDnsIP}`);

    // Catch-all: route all other domains to the interceptor's IP
    lines.push(`address=/#/${interceptorIP}`);

    lines.push('cache-size=1000');
    lines.push('no-hosts');
    lines.push('no-resolv');
    lines.push('log-queries');
    lines.push('log-facility=-');

    return lines.join('\n');
  }

  // ============================================
  // DATABASE HELPERS
  // ============================================

  private getDbProxyImage(databaseType: string): string {
    const dbType = databaseType.toLowerCase();
    switch (dbType) {
      case 'postgres':
      case 'postgresql':
        return DOKKIMI_IMAGES.dbProxyPostgres;
      case 'mysql':
      case 'mariadb':
        return DOKKIMI_IMAGES.dbProxyMysql;
      case 'mongodb':
        return DOKKIMI_IMAGES.dbProxyMongo;
      case 'redis':
        return DOKKIMI_IMAGES.dbProxyRedis;
      default:
        throw new Error(`Unsupported database type for db-proxy: ${dbType}`);
    }
  }

  private getDbProxyPort(databaseType: string): number {
    const dbType = databaseType.toLowerCase();
    if (dbType === 'postgres' || dbType === 'postgresql') {
      return 15432;
    }
    if (dbType === 'mysql' || dbType === 'mariadb') {
      return 13306;
    }
    if (dbType === 'redis') {
      return 16379;
    }
    if (dbType === 'mongodb') {
      return 17017;
    }
    return 8080;
  }

  private getDbInternalPort(databaseType: string): number {
    const dbType = databaseType.toLowerCase();
    if (dbType === 'postgres' || dbType === 'postgresql') {
      return 55432;
    }
    if (dbType === 'mysql' || dbType === 'mariadb') {
      return 33306;
    }
    if (dbType === 'redis') {
      return 63790;
    }
    if (dbType === 'mongodb') {
      return 27018;
    }
    return 18080;
  }

  private setDbInternalPortEnv(
    env: Record<string, string>,
    databaseType: string,
    internalPort: number,
  ): void {
    const dbType = databaseType.toLowerCase();
    if (dbType === 'postgres' || dbType === 'postgresql') {
      env.PGPORT = String(internalPort);
    } else if (dbType === 'mysql' || dbType === 'mariadb') {
      env.MYSQL_TCP_PORT = String(internalPort);
    }
  }

  private getDbCommand(
    databaseType: string,
    internalPort: number,
    baseCommand?: string[],
  ): string[] | undefined {
    const dbType = databaseType.toLowerCase();
    if (dbType === 'redis') {
      const args = baseCommand ? [...baseCommand] : ['redis-server'];
      args.push('--port', String(internalPort));
      return args;
    }
    if (dbType === 'mongodb') {
      return ['mongod', '--port', String(internalPort), '--bind_ip_all'];
    }
    return baseCommand;
  }

  private buildMongoEntrypoint(
    internalPort: number,
    env: Record<string, string>,
    initFileMountPath: string | null,
  ): string {
    const user = env.MONGO_INITDB_ROOT_USERNAME || '';
    const pass = env.MONGO_INITDB_ROOT_PASSWORD || '';
    const hasAuth = !!(user && pass);

    const initBlock = initFileMountPath
      ? `
if [ -d "${initFileMountPath}" ]; then
  for f in ${initFileMountPath}/*; do
    case "$f" in
      *.sh)  echo "Running $f"; . "$f" ;;
      *.js)  echo "Running $f"; mongosh --port ${internalPort} "$f" ;;
    esac
  done
fi`
      : '';

    if (hasAuth) {
      return `
mongod --port ${internalPort} --bind_ip_all --fork --logpath /proc/1/fd/1
until mongosh --port ${internalPort} --eval "db.adminCommand('ping')" &>/dev/null; do sleep 0.5; done
mongosh --port ${internalPort} admin --eval "db.createUser({user:'${user}',pwd:'${pass}',roles:[{role:'root',db:'admin'}]});"
${initBlock}
mongod --port ${internalPort} --shutdown
exec mongod --port ${internalPort} --bind_ip_all --auth`;
    }

    return `
mongod --port ${internalPort} --bind_ip_all --fork --logpath /proc/1/fd/1
until mongosh --port ${internalPort} --eval "db.adminCommand('ping')" &>/dev/null; do sleep 0.5; done
${initBlock}
mongod --port ${internalPort} --shutdown
exec mongod --port ${internalPort} --bind_ip_all`;
  }

  private getInitFileMountPath(databaseType: string): string | null {
    const dbType = databaseType.toLowerCase();
    if (dbType === 'redis') {
      return null;
    }
    return '/docker-entrypoint-initdb.d';
  }

  // ============================================
  // STATUS & IMAGE HELPERS
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

  private async pullAllImages(
    ctx: DeploymentContext,
    attachChromium: boolean,
  ): Promise<void> {
    const pulls: Array<Promise<void>> = [];

    // Infrastructure images (interceptor, test-agent, dnsmasq, db-proxies)
    const infraImages = new Set<string>([
      DOKKIMI_IMAGES.interceptor,
      DOKKIMI_IMAGES.testAgent,
      DOKKIMI_IMAGES.dnsmasq,
    ]);

    for (const item of ctx.definition.items) {
      if (item.type === 'DATABASE' && item.database) {
        infraImages.add(this.getDbProxyImage(item.database));
      }
    }

    if (attachChromium) {
      infraImages.add(resolveBrowserImage(ctx.definition.config?.browser));
    }

    for (const image of infraImages) {
      pulls.push(this.dockerClient.pullImage(image));
    }

    // User service images (with registry auth if available)
    for (const item of ctx.definition.items) {
      if (item.type === 'SERVICE' && item.image) {
        const auth = this.registryService.getAuthConfig(ctx.runId, item.image);
        pulls.push(this.dockerClient.pullImage(item.image, auth));
      }
    }

    // Database images
    const dbImages = new Set<string>();
    for (const item of ctx.definition.items) {
      if (item.type !== 'DATABASE' || !item.database) {
        continue;
      }
      const dbConfig = this.databaseConfig.getConfig(
        item.database,
        {
          dbName: item.dbName ?? undefined,
          dbUser: item.dbUser ?? undefined,
          dbPassword: item.dbPassword ?? undefined,
        },
        item.version ?? undefined,
      );
      if (!dbImages.has(dbConfig.image)) {
        dbImages.add(dbConfig.image);
        pulls.push(this.dockerClient.pullImage(dbConfig.image));
      }
    }

    await Promise.all(pulls);
  }

  // ============================================
  // UTILITIES
  // ============================================

  private envArrayToRecord(
    envArray: Array<{ name: string; value: string }>,
  ): Record<string, string> {
    const record: Record<string, string> = {};
    for (const { name, value } of envArray) {
      record[name] = value;
    }
    return record;
  }
}
