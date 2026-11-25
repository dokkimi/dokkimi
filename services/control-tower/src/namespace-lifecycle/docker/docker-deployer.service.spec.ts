import { NotFoundException } from '@nestjs/common';
import { DockerDeployerService } from './docker-deployer.service';
import { DeploymentContext } from '../deployment-context.types';

jest.mock('dockerode', () => jest.fn(() => ({})));

jest.mock('@dokkimi/config', () => ({
  getConfig: () => ({
    services: {
      interceptor: { port: 8080, host: 'localhost' },
      controlTower: {
        port: 19001,
        host: 'host.docker.internal',
        protocol: 'http',
      },
      testAgent: { port: 8080, host: 'localhost' },
      chromium: { port: 9222 },
    },
    network: { dns: { nameserver: '127.0.0.1' } },
    logging: { actions: false },
    database: {
      defaultName: 'dokkimi',
      defaultUser: 'dokkimi',
      defaultPassword: 'dokkimi',
    },
    browser: {},
  }),
  buildInterceptorEnvVars: jest.fn().mockReturnValue([
    { name: 'PORT', value: '8080' },
    { name: 'NAMESPACE', value: 'test-instance' },
  ]),
  buildTestAgentEnvVars: jest.fn().mockReturnValue([
    { name: 'PORT', value: '8080' },
    { name: 'NAMESPACE', value: 'test-instance' },
  ]),
  buildDbProxyEnvVars: jest.fn().mockReturnValue([
    { name: 'DATABASE_TYPE', value: 'postgres' },
    { name: 'DATABASE_PORT', value: '5432' },
  ]),
  buildBrokerProxyEnvVars: jest.fn().mockReturnValue([
    { name: 'BROKER_TYPE', value: 'amqp' },
    { name: 'BROKER_PORT', value: '55672' },
  ]),
  buildServiceUrl: jest
    .fn()
    .mockReturnValue('http://host.docker.internal:19001'),
}));

const mockDockerClient = {
  createNetwork: jest.fn().mockResolvedValue('dokkimi-run-test-instance'),
  removeNetwork: jest.fn(),
  runContainer: jest.fn().mockResolvedValue('container-id'),
  inspectContainer: jest.fn().mockResolvedValue({
    id: 'container-id',
    name: 'interceptor',
    ip: '172.18.0.2',
    state: 'running',
  }),
  getDockerDnsIP: jest.fn().mockReturnValue('127.0.0.11'),
  pullImage: jest.fn().mockResolvedValue(undefined),
  getExitedContainers: jest.fn().mockResolvedValue([]),
  getExitDetails: jest.fn(),
};

const mockDockerConfig = {
  createConfigDir: jest.fn().mockReturnValue({
    configDir: '/tmp/dokkimi-test',
    configJsonPath: '/tmp/dokkimi-test/config.json',
    dnsmasqDir: '/tmp/dokkimi-test/dnsmasq',
  }),
  writeInterceptorConfig: jest.fn(),
  writeDnsmasqConfig: jest
    .fn()
    .mockReturnValue('/tmp/dokkimi-test/dnsmasq/svc.conf'),
  cleanupConfigDir: jest.fn(),
};

const mockCaService = {
  prepareCaBundleForInstance: jest.fn().mockReturnValue({
    caCertPath: '/home/.dokkimi/ca/ca.crt',
    caKeyPath: '/home/.dokkimi/ca/ca.key',
    caBundlePath: '/tmp/dokkimi-test/ca-bundle.crt',
  }),
  getInterceptorCaBinds: jest
    .fn()
    .mockReturnValue([
      '/home/.dokkimi/ca/ca.crt:/etc/dokkimi/ca/tls.crt:ro',
      '/home/.dokkimi/ca/ca.key:/etc/dokkimi/ca/tls.key:ro',
    ]),
  getServiceCaBinds: jest
    .fn()
    .mockReturnValue([
      '/home/.dokkimi/ca/ca.crt:/etc/ssl/certs/dokkimi-ca.crt:ro',
      '/tmp/dokkimi-test/ca-bundle.crt:/ca-bundle/ca-bundle.crt:ro',
    ]),
  getServiceCaEnvVars: jest.fn().mockReturnValue({
    NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/dokkimi-ca.crt',
    SSL_CERT_FILE: '/ca-bundle/ca-bundle.crt',
  }),
  getInterceptorCaEnvVars: jest.fn().mockReturnValue({
    DOKKIMI_CA_CERT_PATH: '/etc/dokkimi/ca/tls.crt',
    DOKKIMI_CA_KEY_PATH: '/etc/dokkimi/ca/tls.key',
  }),
};

const mockLogCollector = {
  startCollecting: jest.fn().mockResolvedValue(undefined),
  stopCollecting: jest.fn(),
};

const mockInstanceItemService = {
  updateInstanceItemContainerName: jest.fn().mockResolvedValue(undefined),
  updateInstanceItemStatus: jest.fn().mockResolvedValue(undefined),
  updateInstanceItemReadiness: jest.fn().mockResolvedValue(undefined),
  findInstanceItems: jest.fn().mockResolvedValue([]),
};

const mockInstanceService = {
  updateInstanceStatus: jest.fn().mockResolvedValue(undefined),
  updateInstanceDockerNetwork: jest.fn().mockResolvedValue(undefined),
  findInstance: jest.fn(),
  failIfActive: jest.fn(),
  markRunning: jest.fn(),
};

// Import the real extracted services so they wire through to mocked dependencies
import { DockerServiceGroupService } from './docker-service-group.service';
import { DockerDatabaseGroupService } from './docker-database-group.service';
import { DockerBrokerGroupService } from './docker-broker-group.service';
import { DockerDeployConfigService } from './docker-deploy-config.service';
import { DockerImagePullerService } from './docker-image-puller.service';

const mockDatabaseConfig = {
  getConfig: jest.fn().mockReturnValue({
    image: 'postgres:15',
    environment: {
      POSTGRES_DB: 'dokkimi',
      POSTGRES_USER: 'dokkimi',
      POSTGRES_PASSWORD: 'dokkimi',
    },
    ports: [5432],
  }),
};

const mockBrokerConfig = {
  getConfig: jest.fn().mockReturnValue({
    image: 'rabbitmq:3',
    nativePort: 5672,
    internalPort: 10672,
    environment: {},
  }),
};

const mockRegistryService = {
  getAuthConfig: jest.fn().mockReturnValue(undefined),
  storeCredentials: jest.fn(),
  clearCredentials: jest.fn(),
};

const mockRunStorage = {
  getInitFilesDir: jest
    .fn()
    .mockResolvedValue(
      '/home/.dokkimi/storage/instances/test-instance/db-init-files/postgres-db',
    ),
};

function buildCtx(
  overrides: Partial<DeploymentContext> = {},
): DeploymentContext {
  const defaultItems = [
    {
      name: 'api-gateway',
      type: 'SERVICE' as const,
      image: 'myapp/api-gateway:latest',
      port: 3000,
      healthCheck: '/health',
    },
    {
      name: 'user-service',
      type: 'SERVICE' as const,
      image: 'myapp/user-service:latest',
      port: 3000,
    },
    {
      name: 'postgres-db',
      type: 'DATABASE' as const,
      database: 'postgres',
    },
  ];
  return {
    runId: 'run-1',
    instanceId: 'test-instance',
    instanceItemIds: new Map([
      ['api-gateway', 'item-1'],
      ['user-service', 'item-2'],
      ['postgres-db', 'item-3'],
    ]),
    definition: {
      name: 'test-def',
      items: defaultItems,
      tests: [],
    },
    ...overrides,
  };
}

describe('DockerDeployerService', () => {
  let service: DockerDeployerService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDockerClient.createNetwork.mockResolvedValue(
      'dokkimi-run-test-instance',
    );
    mockDockerClient.runContainer.mockResolvedValue('container-id');
    mockDockerClient.inspectContainer.mockResolvedValue({
      id: 'container-id',
      name: 'interceptor',
      ip: '172.18.0.2',
      state: 'running',
    });
    mockDockerClient.getDockerDnsIP.mockReturnValue('127.0.0.11');
    mockDockerClient.pullImage.mockResolvedValue(undefined);
    mockDockerClient.removeNetwork.mockReset();
    mockDockerClient.getExitedContainers.mockReset().mockResolvedValue([]);
    mockDockerClient.getExitDetails.mockReset().mockResolvedValue({
      exitCode: 1,
      oomKilled: false,
      logTail: ['bad config'],
    });
    mockInstanceService.findInstance
      .mockReset()
      .mockResolvedValue({ status: 'RUNNING' });
    mockInstanceService.failIfActive.mockReset().mockResolvedValue(true);
    mockInstanceService.markRunning.mockReset().mockResolvedValue(true);

    const deployConfig = new DockerDeployConfigService(mockDockerConfig as any);
    const serviceGroupSvc = new DockerServiceGroupService(
      mockDockerClient as any,
      mockDockerConfig as any,
      mockCaService as any,
      deployConfig,
      { getBaselinesDir: () => '/nonexistent' } as any,
    );
    const databaseGroupSvc = new DockerDatabaseGroupService(
      mockDockerClient as any,
      mockDatabaseConfig as any,
      mockRunStorage as any,
    );
    const brokerGroupSvc = new DockerBrokerGroupService(
      mockDockerClient as any,
      {
        getConfig: jest.fn().mockReturnValue({
          image: 'rabbitmq:3',
          environment: {},
          nativePort: 5672,
          internalPort: 55672,
        }),
      } as any,
    );
    const imagePuller = new DockerImagePullerService(
      mockDockerClient as any,
      mockDatabaseConfig as any,
      databaseGroupSvc,
      mockBrokerConfig as any,
      brokerGroupSvc,
      mockRegistryService as any,
    );

    service = new DockerDeployerService(
      mockDockerClient as any,
      mockDockerConfig as any,
      mockCaService as any,
      mockLogCollector as any,
      serviceGroupSvc,
      databaseGroupSvc,
      brokerGroupSvc,
      deployConfig,
      imagePuller,
      mockInstanceItemService as any,
      mockInstanceService as any,
    );
  });

  afterEach(async () => {
    jest.useRealTimers();
    mockDockerClient.removeNetwork.mockReset();
    await service.teardown('test-instance'); // stops the crash monitor
  });

  describe('deploy', () => {
    it('should create network, write config, and deploy all container groups', async () => {
      await service.deploy(buildCtx());

      // Network created
      expect(mockDockerClient.createNetwork).toHaveBeenCalledWith(
        'test-instance',
      );

      // Config written
      expect(mockDockerConfig.createConfigDir).toHaveBeenCalledWith(
        'test-instance',
      );
      expect(mockDockerConfig.writeInterceptorConfig).toHaveBeenCalled();

      // CA bundle prepared
      expect(mockCaService.prepareCaBundleForInstance).toHaveBeenCalledWith(
        'test-instance',
      );
    });

    it('should create the global interceptor', async () => {
      await service.deploy(buildCtx());

      const interceptorCall = mockDockerClient.runContainer.mock.calls.find(
        (call: any[]) => call[0].name === 'interceptor-test-instance',
      );
      expect(interceptorCall).toBeDefined();
      expect(interceptorCall![0].networkAliases).toContain(
        'interceptor-service',
      );
      expect(interceptorCall![0].image).toContain('interceptor');
    });

    it('should create the test-agent with config file bind mount', async () => {
      await service.deploy(buildCtx());

      const taCall = mockDockerClient.runContainer.mock.calls.find(
        (call: any[]) => call[0].name === 'test-agent-test-instance',
      );
      expect(taCall).toBeDefined();
      expect(taCall![0].networkAliases).toContain('test-agent-service');
      expect(taCall![0].binds).toEqual(
        expect.arrayContaining([
          expect.stringContaining('config.json:/etc/dokkimi/config.json:ro'),
        ]),
      );
    });

    it('should create service groups with interceptor + dnsmasq + user container', async () => {
      await service.deploy(buildCtx());

      const containerNames = mockDockerClient.runContainer.mock.calls.map(
        (call: any[]) => call[0].name,
      );

      // api-gateway group
      expect(containerNames).toContain('api-gateway-interceptor-test-instance');
      expect(containerNames).toContain('api-gateway-dnsmasq-test-instance');
      expect(containerNames).toContain('api-gateway-test-instance');

      // user-service group
      expect(containerNames).toContain(
        'user-service-interceptor-test-instance',
      );
      expect(containerNames).toContain('user-service-dnsmasq-test-instance');
      expect(containerNames).toContain('user-service-test-instance');
    });

    it('should set user container as primary with network alias', async () => {
      await service.deploy(buildCtx());

      const userCall = mockDockerClient.runContainer.mock.calls.find(
        (call: any[]) => call[0].name === 'api-gateway-test-instance',
      );
      expect(userCall![0].networkAliases).toContain('api-gateway');
      expect(userCall![0].networkMode).toBeUndefined();

      const interceptorCall = mockDockerClient.runContainer.mock.calls.find(
        (call: any[]) =>
          call[0].name === 'api-gateway-interceptor-test-instance',
      );
      expect(interceptorCall![0].networkAliases).toBeUndefined();
    });

    it('should join dnsmasq to user container network namespace', async () => {
      await service.deploy(buildCtx());

      const dnsmasqCall = mockDockerClient.runContainer.mock.calls.find(
        (call: any[]) => call[0].name === 'api-gateway-dnsmasq-test-instance',
      );
      expect(dnsmasqCall![0].networkMode).toBe(
        'container:api-gateway-test-instance',
      );
    });

    it('should inspect interceptor to get IP for dnsmasq config', async () => {
      await service.deploy(buildCtx());

      expect(mockDockerClient.inspectContainer).toHaveBeenCalledWith(
        'api-gateway-interceptor-test-instance',
      );
    });

    it('should mount CA binds on user service containers', async () => {
      await service.deploy(buildCtx());

      const userCall = mockDockerClient.runContainer.mock.calls.find(
        (call: any[]) => call[0].name === 'api-gateway-test-instance',
      );
      expect(userCall![0].binds).toEqual(
        expect.arrayContaining([
          expect.stringContaining('dokkimi-ca.crt:ro'),
          expect.stringContaining('ca-bundle.crt:ro'),
        ]),
      );
    });

    it('should create database groups with db-proxy + database container', async () => {
      await service.deploy(buildCtx());

      const containerNames = mockDockerClient.runContainer.mock.calls.map(
        (call: any[]) => call[0].name,
      );

      expect(containerNames).toContain('postgres-db-dbproxy-test-instance');
      expect(containerNames).toContain('postgres-db-db-test-instance');
    });

    it('should set db-proxy as primary with network alias for database', async () => {
      await service.deploy(buildCtx());

      const dbProxyCall = mockDockerClient.runContainer.mock.calls.find(
        (call: any[]) => call[0].name === 'postgres-db-dbproxy-test-instance',
      );
      expect(dbProxyCall![0].networkAliases).toContain('postgres-db');
    });

    it('should join database container to db-proxy network namespace', async () => {
      await service.deploy(buildCtx());

      const dbCall = mockDockerClient.runContainer.mock.calls.find(
        (call: any[]) => call[0].name === 'postgres-db-db-test-instance',
      );
      expect(dbCall![0].networkMode).toBe(
        'container:postgres-db-dbproxy-test-instance',
      );
    });

    it('should skip items with type MOCK', async () => {
      const mockItems = [
        {
          name: 'mock-stripe',
          type: 'MOCK' as const,
          mockTarget: 'api.stripe.com',
          mockPath: '/v1/charges',
          mockResponseStatus: 200,
          mockResponseBody: '{"id":"ch_test"}',
        },
      ];
      const ctx = buildCtx({
        definition: {
          name: 'test',
          items: mockItems,
        },
      });
      ctx.instanceItemIds = new Map([['mock-stripe', 'item-mock']]);

      await service.deploy(ctx);

      // Only global interceptor + test-agent, no service/db groups
      const containerNames = mockDockerClient.runContainer.mock.calls.map(
        (call: any[]) => call[0].name,
      );
      expect(containerNames).toEqual([
        'interceptor-test-instance',
        'test-agent-test-instance',
      ]);
    });

    it('should not create chromium group when no UI steps', async () => {
      await service.deploy(buildCtx());

      const containerNames = mockDockerClient.runContainer.mock.calls.map(
        (call: any[]) => call[0].name,
      );
      expect(containerNames.some((n: string) => n.includes('chromium'))).toBe(
        false,
      );
    });

    it('should create chromium group when UI steps exist', async () => {
      const uiItems = [
        {
          name: 'web-app',
          type: 'SERVICE' as const,
          image: 'myapp/web:latest',
          port: 3000,
        },
      ];
      const ctx = buildCtx({
        definition: {
          name: 'ui-test',
          items: uiItems,
          tests: [
            {
              name: 'ui test',
              steps: [
                { action: { type: 'ui', target: 'web-app', steps: [] } } as any,
              ],
            },
          ],
        },
      });
      ctx.instanceItemIds = new Map([
        ['web-app', 'item-web'],
        ['chromium', 'item-chromium'],
      ]);

      await service.deploy(ctx);

      const containerNames = mockDockerClient.runContainer.mock.calls.map(
        (call: any[]) => call[0].name,
      );
      expect(containerNames).toContain('chromium-interceptor-test-instance');
      expect(containerNames).toContain('chromium-dnsmasq-test-instance');
      expect(containerNames).toContain('chromium-test-instance');
    });
  });

  describe('log collection', () => {
    it('should start collecting logs for interceptors and db-proxies (user containers use GELF)', async () => {
      await service.deploy(buildCtx());

      // 1 db-proxy = 1 call (user containers use GELF log driver instead of dockerode streaming)
      expect(mockLogCollector.startCollecting).toHaveBeenCalledTimes(1);
    });
  });

  describe('teardown', () => {
    it('should stop log collection, remove network, and cleanup config dir', async () => {
      await service.teardown('test-instance');

      expect(mockLogCollector.stopCollecting).toHaveBeenCalledWith(
        'test-instance',
      );
      expect(mockDockerClient.removeNetwork).toHaveBeenCalledWith(
        'test-instance',
      );
      expect(mockDockerConfig.cleanupConfigDir).toHaveBeenCalledWith(
        'test-instance',
      );
    });
  });

  describe('deployment failure', () => {
    it('should teardown and set status to FAILED when container start fails', async () => {
      mockDockerClient.runContainer
        .mockResolvedValueOnce('interceptor-id')
        .mockResolvedValueOnce('test-agent-id')
        .mockRejectedValueOnce(new Error('container start failed'));

      const onFailure = jest.fn();
      await expect(service.deploy(buildCtx(), onFailure)).rejects.toThrow(
        'container start failed',
      );

      expect(mockLogCollector.stopCollecting).toHaveBeenCalledWith(
        'test-instance',
      );
      expect(mockDockerClient.removeNetwork).toHaveBeenCalledWith(
        'test-instance',
      );
      expect(mockDockerConfig.cleanupConfigDir).toHaveBeenCalledWith(
        'test-instance',
      );
      expect(mockInstanceService.failIfActive).toHaveBeenCalledWith(
        'test-instance',
        'container start failed',
      );
      expect(onFailure).toHaveBeenCalledWith('test-instance');
    });

    it('should not fail an instance that was stopped during deployment', async () => {
      const onFailure = jest.fn();
      mockInstanceService.markRunning.mockResolvedValue(false);
      mockInstanceService.failIfActive.mockResolvedValue(false);
      await expect(service.deploy(buildCtx(), onFailure)).rejects.toThrow(
        'stopped during deployment',
      );
      expect(mockDockerClient.removeNetwork).toHaveBeenCalled();
      expect(onFailure).not.toHaveBeenCalled();
      expect(mockInstanceService.updateInstanceStatus).not.toHaveBeenCalled();
    });

    it('should explain the error with a container that exited', async () => {
      mockDockerClient.runContainer.mockRejectedValue(
        new Error('cannot join network namespace of a non running container'),
      );
      mockDockerClient.getExitedContainers.mockResolvedValue([
        { id: 'c1', role: 'service', itemName: 'api-gateway' },
      ]);
      await expect(service.deploy(buildCtx())).rejects.toThrow(
        'Container(s) crashed: api-gateway (exit 1): bad config',
      );
      expect(
        mockDockerClient.getExitDetails.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mockDockerClient.removeNetwork.mock.invocationCallOrder[0],
      );
    });

    it('should keep the error when the exited containers are unknown', async () => {
      mockDockerClient.runContainer.mockRejectedValue(
        new Error('no such image'),
      );
      mockDockerClient.getExitedContainers.mockRejectedValue(new Error('x'));
      await expect(service.deploy(buildCtx())).rejects.toThrow(
        'containers failed',
      );
    });

    it('should wait for all parallel containers before teardown', async () => {
      const callOrder: string[] = [];

      mockDockerClient.runContainer.mockImplementation(async (opts: any) => {
        if (opts.name === 'interceptor-test-instance') {
          callOrder.push('interceptor-start');
          return 'interceptor-id';
        }
        if (opts.name === 'test-agent-test-instance') {
          callOrder.push('test-agent-start');
          throw new Error('test-agent failed');
        }
        callOrder.push(`${opts.name}-start`);
        return 'container-id';
      });

      mockDockerClient.removeNetwork.mockImplementation(async () => {
        callOrder.push('teardown');
      });

      await expect(service.deploy(buildCtx())).rejects.toThrow(
        'test-agent failed',
      );

      const interceptorIdx = callOrder.indexOf('interceptor-start');
      const teardownIdx = callOrder.indexOf('teardown');
      expect(interceptorIdx).toBeLessThan(teardownIdx);
    });
  });

  describe('crashed containers', () => {
    const onFailure = jest.fn();
    const check = () => jest.advanceTimersByTimeAsync(3000);
    const exited = (role: string, itemName?: string) =>
      mockDockerClient.getExitedContainers.mockResolvedValue([
        { id: 'c1', role, itemName },
      ]);

    beforeEach(async () => {
      jest.useFakeTimers();
      await service.deploy(buildCtx(), onFailure);
    });

    it.each([
      ['service', 'api', 'api'],
      ['worker', 'jobs', 'jobs'],
      ['database', 'pg', 'pg'],
      ['broker', 'mq', 'mq'],
      ['broker-proxy', 'mq', "Dokkimi's broker proxy for mq"],
      ['dnsmasq', 'api', "Dokkimi's dnsmasq for api"],
      ['test-agent', undefined, "Dokkimi's test agent"],
      ['chromium', undefined, "Dokkimi's chromium"],
    ])('fails the instance when a %s exits', async (role, item, name) => {
      await check();
      expect(mockInstanceService.failIfActive).not.toHaveBeenCalled();

      exited(role, item);
      await check();

      expect(mockInstanceService.failIfActive).toHaveBeenCalledWith(
        'test-instance',
        `Container(s) crashed: ${name} (exit 1): bad config`,
      );
      expect(mockDockerClient.removeNetwork).toHaveBeenCalledTimes(1);
      expect(onFailure).toHaveBeenCalledTimes(1);

      await check();
      expect(mockDockerClient.getExitedContainers).toHaveBeenCalledTimes(2);
    });

    it("names the user's containers first", async () => {
      mockDockerClient.getExitedContainers.mockResolvedValue([
        { id: 'c1', role: 'broker-proxy', itemName: 'mq' },
        { id: 'c2', role: 'broker', itemName: 'mq' },
      ]);
      mockDockerClient.getExitDetails.mockRejectedValue(new Error('gone'));
      await check();
      expect(mockInstanceService.failIfActive).toHaveBeenCalledWith(
        'test-instance',
        "Container(s) crashed: mq; Dokkimi's broker proxy for mq",
      );
    });

    it('keeps checking after an error', async () => {
      mockDockerClient.getExitedContainers.mockRejectedValueOnce(
        new Error('temporary'),
      );
      await check();
      mockInstanceService.findInstance.mockRejectedValueOnce(
        new Error('database is locked'),
      );
      await check();
      expect(onFailure).not.toHaveBeenCalled();

      exited('service', 'api');
      await check();
      expect(onFailure).toHaveBeenCalledTimes(1);
    });

    it('does not start a check while one is running', async () => {
      mockDockerClient.getExitedContainers.mockReturnValue(
        new Promise(() => {}),
      );
      await check();
      await check();
      await check();
      expect(mockDockerClient.getExitedContainers).toHaveBeenCalledTimes(1);
    });

    it('does not report containers that exit once the test is over', async () => {
      mockInstanceService.failIfActive.mockResolvedValue(false);
      exited('service', 'api');
      await check();
      expect(mockInstanceService.failIfActive).toHaveBeenCalled();
      expect(mockDockerClient.removeNetwork).not.toHaveBeenCalled();
      expect(onFailure).not.toHaveBeenCalled();
    });

    it('reports the crash when the teardown fails', async () => {
      mockDockerClient.removeNetwork.mockRejectedValue(new Error('busy'));
      exited('service', 'api');
      await check();
      expect(onFailure).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        'the instance is deleted',
        () =>
          mockInstanceService.findInstance.mockRejectedValue(
            new NotFoundException(),
          ),
      ],
      [
        'the instance has stopped',
        () =>
          mockInstanceService.findInstance.mockResolvedValue({
            status: 'STOPPED',
          }),
      ],
      ['the instance is removed', () => void service.teardown('test-instance')],
    ])('stops checking when %s', async (_, end) => {
      end();
      await check();
      mockInstanceService.findInstance
        .mockReset()
        .mockResolvedValue({ status: 'RUNNING' });
      exited('service', 'api');
      await check();
      await check();
      expect(onFailure).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('waiting for stage 0', () => {
    it('returns once the deployment is done', async () => {
      let finish = (_: string) => {};
      mockDockerClient.runContainer.mockImplementation(
        (opts: { name: string }) =>
          opts.name.includes('dnsmasq')
            ? new Promise<string>((resolve) => (finish = resolve))
            : Promise.resolve('container-id'),
      );
      const deployment = service.deploy(
        buildCtx({
          definition: {
            name: 'test-def',
            tests: [],
            items: [{ name: 'api-gateway', type: 'SERVICE', image: 'i' }],
          },
        }),
      );
      const done = jest.fn();
      const wait = service.deployStage('test-instance', 0).then(done);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(done).not.toHaveBeenCalled();

      finish('container-id');
      await Promise.all([deployment, wait]);
      expect(mockInstanceService.markRunning).toHaveBeenCalled();
    });

    it('fails with the deployment', async () => {
      mockDockerClient.runContainer.mockRejectedValue(new Error('no space'));
      const deployment = service.deploy(buildCtx());
      const wait = service.deployStage('test-instance', 0);
      await expect(deployment).rejects.toThrow('no space');
      await expect(wait).rejects.toThrow('no space');
    });

    it('fails without a deployment', async () => {
      await expect(service.deployStage('test-instance', 0)).rejects.toThrow(
        'No deployment session',
      );
    });
  });

  describe('failed stage', () => {
    const onFailure = jest.fn();
    const stagedCtx = () =>
      buildCtx({
        definition: {
          name: 'test-def',
          tests: [],
          items: [
            { name: 'postgres-db', type: 'DATABASE', database: 'postgres' },
            { name: 'api-gateway', type: 'SERVICE', image: 'i', stage: 1 },
          ] as any,
        },
      });

    const deployStage = async () => {
      const result = service.deployStage('test-instance', 1).then(
        () => null,
        (err: Error) => err.message,
      );
      await jest.advanceTimersByTimeAsync(1000);
      return result;
    };

    beforeEach(async () => {
      jest.useFakeTimers();
      mockInstanceItemService.findInstanceItems.mockResolvedValue([
        { id: 'item-1', status: 'PENDING' },
      ]);
      await service.deploy(stagedCtx(), onFailure);
      mockDockerClient.runContainer.mockRejectedValue(new Error('no network'));
    });

    it('saves the error and ends the run', async () => {
      expect(await deployStage()).toBe('no network');
      expect(mockInstanceService.failIfActive).toHaveBeenCalledWith(
        'test-instance',
        'no network',
      );
      expect(mockDockerClient.removeNetwork).toHaveBeenCalled();
      expect(onFailure).toHaveBeenCalledWith('test-instance');
    });

    it('explains the error with the container that exited', async () => {
      mockDockerClient.getExitedContainers.mockResolvedValue([
        { id: 'c1', role: 'service', itemName: 'api-gateway' },
      ]);
      const message = 'Container(s) crashed: api-gateway (exit 1): bad config';
      expect(await deployStage()).toBe(message);
      expect(mockInstanceService.failIfActive).toHaveBeenCalledWith(
        'test-instance',
        message,
      );
    });

    it('waits for Docker to list the container as exited', async () => {
      mockDockerClient.getExitedContainers
        .mockResolvedValueOnce([])
        .mockResolvedValue([
          { id: 'c1', role: 'service', itemName: 'api-gateway' },
        ]);
      expect(await deployStage()).toBe(
        'Container(s) crashed: api-gateway (exit 1): bad config',
      );
    });

    it('cleans up without reporting when the instance was stopped', async () => {
      mockInstanceService.failIfActive.mockResolvedValue(false);
      expect(await deployStage()).not.toBeNull();
      expect(mockDockerClient.removeNetwork).toHaveBeenCalled();
      expect(onFailure).not.toHaveBeenCalled();
    });
  });
});
