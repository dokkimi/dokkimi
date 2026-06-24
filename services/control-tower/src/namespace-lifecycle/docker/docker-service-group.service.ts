import { Injectable, Logger } from '@nestjs/common';
import {
  getConfig,
  buildInterceptorEnvVars,
  buildTestAgentEnvVars,
} from '@dokkimi/config';
import { DockerClientService } from './docker-client.service';
import {
  DockerConfigService,
  InstanceConfigPaths,
} from './docker-config.service';
import { DockerCaService, CaBundlePaths } from './docker-ca.service';
import { DockerDeployConfigService } from './docker-deploy-config.service';
import {
  DOKKIMI_IMAGES,
  resolveBrowserImage,
} from '../../constants/image-tags';
import { DefinitionItem, BrowserConfig } from '../deployment-context.types';
import { envArrayToRecord } from './env.utils';
import { RunStorageService } from '../../storage/run-storage.service';
import * as fs from 'fs';

@Injectable()
export class DockerServiceGroupService {
  private readonly logger = new Logger(DockerServiceGroupService.name);

  constructor(
    private readonly dockerClient: DockerClientService,
    private readonly dockerConfig: DockerConfigService,
    private readonly caService: DockerCaService,
    private readonly deployConfig: DockerDeployConfigService,
    private readonly runStorage: RunStorageService,
  ) {}

  async createGlobalInterceptor(
    networkName: string,
    instanceId: string,
    dockerDnsIP: string,
    configPaths: InstanceConfigPaths,
  ): Promise<void> {
    const config = getConfig();
    const envEntries = buildInterceptorEnvVars(config, {
      namespace: instanceId,
      apiKey: 'dokkimi-interceptor-key',
      dnsIP: dockerDnsIP,
      origin: '',
      testAgentUrl: `http://test-agent-service:${config.services.testAgent.port}`,
    });

    await this.dockerClient.runContainer({
      name: `interceptor-${instanceId}`,
      image: DOKKIMI_IMAGES.interceptor,
      networkName,
      networkAliases: ['interceptor-service'],
      env: {
        ...envArrayToRecord(envEntries),
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

  async createTestAgent(
    networkName: string,
    instanceId: string,
    hasUi: boolean,
    configPaths: InstanceConfigPaths,
  ): Promise<void> {
    const config = getConfig();
    const envEntries = buildTestAgentEnvVars(config, {
      namespace: networkName,
      browserURL: hasUi
        ? `http://chromium:${config.services.chromium.port}`
        : undefined,
      defaultViewportWidth: config.browser?.defaultViewportWidth,
      defaultViewportHeight: config.browser?.defaultViewportHeight,
    });

    const env = envArrayToRecord(envEntries);
    env.INTERCEPTOR_URL = `http://interceptor-service:${config.services.interceptor.port}`;
    env.CONFIG_SOURCE = 'file';
    env.CONFIG_FILE_PATH = '/etc/dokkimi/config.json';

    const binds = [`${configPaths.configJsonPath}:/etc/dokkimi/config.json:ro`];
    const baselinesDir = this.runStorage.getBaselinesDir(instanceId);
    if (fs.existsSync(baselinesDir)) {
      binds.push(`${baselinesDir}:/etc/dokkimi/baselines:ro`);
      env.BASELINES_PATH = '/etc/dokkimi/baselines';
    }

    await this.dockerClient.runContainer({
      name: `test-agent-${instanceId}`,
      image: DOKKIMI_IMAGES.testAgent,
      networkName,
      networkAliases: ['test-agent-service'],
      env,
      binds,
      exposedPorts: [config.services.testAgent.port],
      labels: {
        'io.dokkimi.instance-id': instanceId,
        'io.dokkimi.role': 'test-agent',
      },
    });

    this.logger.log('Test-agent GELF receiver will listen on UDP 12201');
  }

  async createServiceGroup(
    networkName: string,
    instanceId: string,
    item: DefinitionItem,
    containerName: string,
    instanceItemId: string | undefined,
    dockerDnsIP: string,
    configPaths: InstanceConfigPaths,
    caBundlePaths: CaBundlePaths,
    databaseNames: string[],
    testAgentIP?: string,
  ): Promise<{ userContainerId: string | null; interceptorName: string }> {
    if (!item.image) {
      this.logger.warn(`Skipping service ${item.name} — no image specified`);
      return { userContainerId: null, interceptorName: '' };
    }

    const config = getConfig();

    const interceptorName = `${containerName}-interceptor-${instanceId}`;
    const interceptorEnv = buildInterceptorEnvVars(config, {
      namespace: instanceId,
      apiKey: 'dokkimi-interceptor-key',
      dnsIP: dockerDnsIP,
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
        ...envArrayToRecord(interceptorEnv),
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

    const interceptorInfo =
      await this.dockerClient.inspectContainer(interceptorName);
    const interceptorIP = interceptorInfo?.ip;
    if (!interceptorIP) {
      throw new Error(`Failed to get IP for interceptor ${interceptorName}`);
    }

    const dnsmasqConf = this.deployConfig.buildDnsmasqConfig(
      dockerDnsIP,
      databaseNames,
      interceptorIP,
    );
    const dnsmasqConfPath = this.dockerConfig.writeDnsmasqConfig(
      configPaths,
      containerName,
      dnsmasqConf,
    );

    const userContainerName = `${containerName}-${instanceId}`;
    const userEnv: Record<string, string> = {
      ...this.caService.getServiceCaEnvVars(),
      HOSTNAME: '0.0.0.0',
    };

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
      ...(item.command ? { cmd: item.command } : {}),
      ...(testAgentIP
        ? {
            logConfig: {
              Type: 'gelf',
              Config: {
                'gelf-address': `udp://${testAgentIP}:12201`,
                'gelf-compression-type': 'none',
                tag: item.name,
              },
            },
          }
        : {}),
    });

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

  async createChromiumGroup(
    networkName: string,
    instanceId: string,
    dockerDnsIP: string,
    configPaths: InstanceConfigPaths,
    caBundlePaths: CaBundlePaths,
    databaseNames: string[],
    browser?: BrowserConfig,
  ): Promise<void> {
    const config = getConfig();
    const chromiumPort = config.services.chromium.port;
    const browserImage = resolveBrowserImage(browser);

    const interceptorName = `chromium-interceptor-${instanceId}`;
    const interceptorEnv = buildInterceptorEnvVars(config, {
      namespace: instanceId,
      apiKey: 'dokkimi-interceptor-key',
      dnsIP: dockerDnsIP,
      origin: 'chromium',
      instanceItemName: 'chromium',
      healthCheckEndpoint: '/json/version',
      servicePort: String(config.services.chromium.port),
      namespaceItemId: 'chromium',
      testAgentUrl: `http://test-agent-service:${config.services.testAgent.port}`,
    });

    await this.dockerClient.runContainer({
      name: interceptorName,
      image: DOKKIMI_IMAGES.interceptor,
      networkName,
      env: {
        ...envArrayToRecord(interceptorEnv),
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

    const interceptorInfo =
      await this.dockerClient.inspectContainer(interceptorName);
    const interceptorIP = interceptorInfo?.ip;
    if (!interceptorIP) {
      throw new Error(`Failed to get IP for interceptor ${interceptorName}`);
    }

    const dnsmasqConf = this.deployConfig.buildDnsmasqConfig(
      dockerDnsIP,
      databaseNames,
      interceptorIP,
    );
    const dnsmasqConfPath = this.dockerConfig.writeDnsmasqConfig(
      configPaths,
      'chromium',
      dnsmasqConf,
    );

    const chromiumContainerName = `chromium-${instanceId}`;
    await this.dockerClient.runContainer({
      name: chromiumContainerName,
      image: browserImage,
      networkName,
      networkAliases: ['chromium'],
      cmd: ['--disable-dev-shm-usage', '--ignore-certificate-errors'],
      env: this.caService.getServiceCaEnvVars(),
      binds: [
        `${configPaths.resolvConfPath}:/etc/resolv.conf:ro`,
        ...this.caService.getServiceCaBinds(caBundlePaths),
      ],
      exposedPorts: [chromiumPort],
      labels: {
        'io.dokkimi.instance-id': instanceId,
        'io.dokkimi.role': 'chromium',
      },
    });

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
}
