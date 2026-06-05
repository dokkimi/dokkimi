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
};

const mockInstanceService = {
  updateInstanceStatus: jest.fn().mockResolvedValue(undefined),
  updateInstanceDockerNetwork: jest.fn().mockResolvedValue(undefined),
};

// Import the real extracted services so they wire through to mocked dependencies
import { DockerServiceGroupService } from './docker-service-group.service';
import { DockerDatabaseGroupService } from './docker-database-group.service';
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
      items: [
        {
          name: 'api-gateway',
          type: 'SERVICE',
          image: 'myapp/api-gateway:latest',
          port: 3000,
          healthCheck: '/health',
        },
        {
          name: 'user-service',
          type: 'SERVICE',
          image: 'myapp/user-service:latest',
          port: 3000,
        },
        {
          name: 'postgres-db',
          type: 'DATABASE',
          database: 'postgres',
        },
      ],
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

    const deployConfig = new DockerDeployConfigService(mockDockerConfig as any);
    const serviceGroupSvc = new DockerServiceGroupService(
      mockDockerClient as any,
      mockDockerConfig as any,
      mockCaService as any,
      deployConfig,
    );
    const databaseGroupSvc = new DockerDatabaseGroupService(
      mockDockerClient as any,
      mockDatabaseConfig as any,
      mockRunStorage as any,
    );
    const imagePuller = new DockerImagePullerService(
      mockDockerClient as any,
      mockDatabaseConfig as any,
      databaseGroupSvc,
      mockRegistryService as any,
    );

    service = new DockerDeployerService(
      mockDockerClient as any,
      mockDockerConfig as any,
      mockCaService as any,
      mockLogCollector as any,
      serviceGroupSvc,
      databaseGroupSvc,
      deployConfig,
      imagePuller,
      mockInstanceItemService as any,
      mockInstanceService as any,
    );
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
      const ctx = buildCtx({
        definition: {
          name: 'test',
          items: [
            {
              name: 'mock-stripe',
              type: 'MOCK',
              mockTarget: 'api.stripe.com',
              mockPath: '/v1/charges',
              mockResponseStatus: 200,
              mockResponseBody: '{"id":"ch_test"}',
            },
          ],
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
      const ctx = buildCtx({
        definition: {
          name: 'ui-test',
          items: [
            {
              name: 'web-app',
              type: 'SERVICE',
              image: 'myapp/web:latest',
              port: 3000,
            },
          ],
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
      ctx.instanceItemIds = new Map([['web-app', 'item-web']]);

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
    it('should start collecting logs for each service container', async () => {
      await service.deploy(buildCtx());

      expect(mockLogCollector.startCollecting).toHaveBeenCalledWith(
        'test-instance',
        'container-id',
        'api-gateway',
        'item-1',
      );
      expect(mockLogCollector.startCollecting).toHaveBeenCalledWith(
        'test-instance',
        'container-id',
        'user-service',
        'item-2',
      );
      // 2 user containers + 2 interceptors + 1 db-proxy = 5 calls
      expect(mockLogCollector.startCollecting).toHaveBeenCalledTimes(5);
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

      await expect(service.deploy(buildCtx())).rejects.toThrow(
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
      expect(mockInstanceService.updateInstanceStatus).toHaveBeenCalledWith(
        'test-instance',
        'FAILED',
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
});
