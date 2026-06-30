import { DockerServiceGroupService } from './docker-service-group.service';
import { DefinitionItem } from '../deployment-context.types';
import { InstanceConfigPaths } from './docker-config.service';
import { CaBundlePaths } from './docker-ca.service';

jest.mock('dockerode', () => jest.fn(() => ({})));

jest.mock('@dokkimi/config', () => ({
  getConfig: () => ({
    services: {
      interceptor: { port: 80, host: 'localhost' },
      controlTower: {
        port: 19001,
        host: 'host.docker.internal',
        protocol: 'http',
      },
      testAgent: { port: 80, host: 'localhost' },
      chromium: { port: 9222 },
    },
    network: { dns: { nameserver: '127.0.0.1' } },
    logging: { actions: false },
    browser: { defaultViewportWidth: 1280, defaultViewportHeight: 720 },
  }),
  buildInterceptorEnvVars: jest.fn().mockReturnValue([
    { name: 'PORT', value: '80' },
    { name: 'NAMESPACE', value: 'test-instance' },
  ]),
  buildTestAgentEnvVars: jest.fn().mockReturnValue([
    { name: 'PORT', value: '80' },
    { name: 'NAMESPACE', value: 'test-network' },
  ]),
  buildServiceUrl: jest
    .fn()
    .mockReturnValue('http://host.docker.internal:19001'),
}));

const mockDockerClient = {
  runContainer: jest.fn().mockResolvedValue('container-id'),
  inspectContainer: jest.fn().mockResolvedValue({
    id: 'container-id',
    name: 'interceptor',
    ip: '172.18.0.5',
    state: 'running',
  }),
};

const mockDockerConfig = {
  writeDnsmasqConfig: jest
    .fn()
    .mockReturnValue('/tmp/dokkimi-test/dnsmasq/svc.conf'),
};

const mockCaService = {
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

const mockDeployConfig = {
  buildDnsmasqConfig: jest.fn().mockReturnValue('listen-address=127.0.0.1\n'),
};

const configPaths: InstanceConfigPaths = {
  configDir: '/tmp/dokkimi-test',
  configJsonPath: '/tmp/dokkimi-test/config.json',
  dnsmasqDir: '/tmp/dokkimi-test/dnsmasq',
  resolvConfPath: '/tmp/dokkimi-test/resolv.conf',
};

const caBundlePaths: CaBundlePaths = {
  caCertPath: '/home/.dokkimi/ca/ca.crt',
  caKeyPath: '/home/.dokkimi/ca/ca.key',
  caBundlePath: '/tmp/dokkimi-test/ca-bundle.crt',
};

function buildServiceItem(
  overrides: Partial<DefinitionItem> = {},
): DefinitionItem {
  return {
    name: 'api-gateway',
    type: 'SERVICE',
    image: 'my-org/api-gateway:latest',
    port: 3000,
    ...overrides,
  };
}

let service: DockerServiceGroupService;

beforeEach(() => {
  jest.clearAllMocks();
  service = new DockerServiceGroupService(
    mockDockerClient as any,
    mockDockerConfig as any,
    mockCaService as any,
    mockDeployConfig as any,
    { getBaselinesDir: () => '/nonexistent' } as any,
  );
});

describe('DockerServiceGroupService', () => {
  describe('createGlobalInterceptor', () => {
    it('should create interceptor with correct name and network alias', async () => {
      await service.createGlobalInterceptor(
        'dokkimi-run-inst1',
        'inst1',
        '127.0.0.11',
        configPaths,
      );

      expect(mockDockerClient.runContainer).toHaveBeenCalledTimes(1);
      const call = mockDockerClient.runContainer.mock.calls[0][0];
      expect(call.name).toBe('interceptor-inst1');
      expect(call.networkAliases).toEqual(['interceptor-service']);
      expect(call.networkName).toBe('dokkimi-run-inst1');
    });

    it('should set DEPLOY_MODE and CONFIG_FILE_PATH env vars', async () => {
      await service.createGlobalInterceptor(
        'dokkimi-run-inst1',
        'inst1',
        '127.0.0.11',
        configPaths,
      );

      const call = mockDockerClient.runContainer.mock.calls[0][0];
      expect(call.env.DEPLOY_MODE).toBe('docker');
      expect(call.env.CONFIG_FILE_PATH).toBe('/etc/dokkimi/config.json');
    });

    it('should mount config json and CA binds', async () => {
      await service.createGlobalInterceptor(
        'dokkimi-run-inst1',
        'inst1',
        '127.0.0.11',
        configPaths,
      );

      const call = mockDockerClient.runContainer.mock.calls[0][0];
      expect(call.binds).toContain(
        '/tmp/dokkimi-test/config.json:/etc/dokkimi/config.json:ro',
      );
      expect(call.binds).toEqual(
        expect.arrayContaining(mockCaService.getInterceptorCaBinds()),
      );
    });

    it('should set instance-id and role labels', async () => {
      await service.createGlobalInterceptor(
        'dokkimi-run-inst1',
        'inst1',
        '127.0.0.11',
        configPaths,
      );

      const call = mockDockerClient.runContainer.mock.calls[0][0];
      expect(call.labels['io.dokkimi.instance-id']).toBe('inst1');
      expect(call.labels['io.dokkimi.role']).toBe('interceptor');
    });
  });

  describe('createTestAgent', () => {
    it('should create test-agent with correct name and alias', async () => {
      await service.createTestAgent(
        'dokkimi-run-inst1',
        'inst1',
        false,
        configPaths,
      );

      const call = mockDockerClient.runContainer.mock.calls[0][0];
      expect(call.name).toBe('test-agent-inst1');
      expect(call.networkAliases).toEqual(['test-agent-service']);
    });

    it('should set CONFIG_SOURCE=file and INTERCEPTOR_URL', async () => {
      await service.createTestAgent(
        'dokkimi-run-inst1',
        'inst1',
        false,
        configPaths,
      );

      const call = mockDockerClient.runContainer.mock.calls[0][0];
      expect(call.env.CONFIG_SOURCE).toBe('file');
      expect(call.env.CONFIG_FILE_PATH).toBe('/etc/dokkimi/config.json');
      expect(call.env.INTERCEPTOR_URL).toBe('http://interceptor-service:80');
    });

    it('should set role label to test-agent', async () => {
      await service.createTestAgent(
        'dokkimi-run-inst1',
        'inst1',
        false,
        configPaths,
      );

      const call = mockDockerClient.runContainer.mock.calls[0][0];
      expect(call.labels['io.dokkimi.role']).toBe('test-agent');
    });
  });

  describe('createServiceGroup', () => {
    it('should create 3 containers: interceptor, user, dnsmasq', async () => {
      await service.createServiceGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildServiceItem(),
        'api-gateway',
        'item-1',
        '127.0.0.11',
        configPaths,
        caBundlePaths,
        ['postgres-db'],
      );

      expect(mockDockerClient.runContainer).toHaveBeenCalledTimes(3);
    });

    it('should create interceptor first to get its IP', async () => {
      const callOrder: string[] = [];
      mockDockerClient.runContainer.mockImplementation(async (opts: any) => {
        callOrder.push(opts.name);
        return 'container-id';
      });

      await service.createServiceGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildServiceItem(),
        'api-gateway',
        'item-1',
        '127.0.0.11',
        configPaths,
        caBundlePaths,
        [],
      );

      expect(callOrder[0]).toBe('api-gateway-interceptor-inst1');
      expect(callOrder[1]).toBe('api-gateway-inst1');
      expect(callOrder[2]).toBe('api-gateway-dnsmasq-inst1');
    });

    it('should inspect interceptor to get IP for dnsmasq config', async () => {
      await service.createServiceGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildServiceItem(),
        'api-gateway',
        'item-1',
        '127.0.0.11',
        configPaths,
        caBundlePaths,
        [],
      );

      expect(mockDockerClient.inspectContainer).toHaveBeenCalledWith(
        'api-gateway-interceptor-inst1',
      );
      expect(mockDeployConfig.buildDnsmasqConfig).toHaveBeenCalledWith(
        '127.0.0.11',
        [],
        '172.18.0.5',
      );
    });

    it('should throw if interceptor IP cannot be resolved', async () => {
      mockDockerClient.inspectContainer.mockResolvedValueOnce({
        id: 'id',
        name: 'n',
        ip: '',
        state: 'running',
      });

      await expect(
        service.createServiceGroup(
          'dokkimi-run-inst1',
          'inst1',
          buildServiceItem(),
          'api-gateway',
          'item-1',
          '127.0.0.11',
          configPaths,
          caBundlePaths,
          [],
        ),
      ).rejects.toThrow('Failed to get IP');
    });

    it('should set interceptor role label to service-interceptor', async () => {
      await service.createServiceGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildServiceItem(),
        'api-gateway',
        'item-1',
        '127.0.0.11',
        configPaths,
        caBundlePaths,
        [],
      );

      const interceptorCall = mockDockerClient.runContainer.mock.calls[0][0];
      expect(interceptorCall.labels['io.dokkimi.role']).toBe(
        'service-interceptor',
      );
      expect(interceptorCall.labels['io.dokkimi.item-name']).toBe(
        'api-gateway',
      );
    });

    it('should give user container the network alias', async () => {
      await service.createServiceGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildServiceItem(),
        'api-gateway',
        'item-1',
        '127.0.0.11',
        configPaths,
        caBundlePaths,
        [],
      );

      const userCall = mockDockerClient.runContainer.mock.calls[1][0];
      expect(userCall.networkAliases).toEqual(['api-gateway']);
      expect(userCall.name).toBe('api-gateway-inst1');
    });

    it('should not give interceptor a network alias', async () => {
      await service.createServiceGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildServiceItem(),
        'api-gateway',
        'item-1',
        '127.0.0.11',
        configPaths,
        caBundlePaths,
        [],
      );

      const interceptorCall = mockDockerClient.runContainer.mock.calls[0][0];
      expect(interceptorCall.networkAliases).toBeUndefined();
    });

    it('should join dnsmasq to user container network namespace', async () => {
      await service.createServiceGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildServiceItem(),
        'api-gateway',
        'item-1',
        '127.0.0.11',
        configPaths,
        caBundlePaths,
        [],
      );

      const dnsmasqCall = mockDockerClient.runContainer.mock.calls[2][0];
      expect(dnsmasqCall.networkMode).toBe('container:api-gateway-inst1');
      expect(dnsmasqCall.name).toBe('api-gateway-dnsmasq-inst1');
    });

    it('should set HOSTNAME=0.0.0.0 on user container', async () => {
      await service.createServiceGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildServiceItem(),
        'api-gateway',
        'item-1',
        '127.0.0.11',
        configPaths,
        caBundlePaths,
        [],
      );

      const userCall = mockDockerClient.runContainer.mock.calls[1][0];
      expect(userCall.env.HOSTNAME).toBe('0.0.0.0');
    });

    it('should mount resolv.conf and CA binds on user container', async () => {
      await service.createServiceGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildServiceItem(),
        'api-gateway',
        'item-1',
        '127.0.0.11',
        configPaths,
        caBundlePaths,
        [],
      );

      const userCall = mockDockerClient.runContainer.mock.calls[1][0];
      expect(userCall.binds).toContain(
        '/tmp/dokkimi-test/resolv.conf:/etc/resolv.conf:ro',
      );
      expect(userCall.binds).toEqual(
        expect.arrayContaining(mockCaService.getServiceCaBinds()),
      );
    });

    it('should merge user-defined env vars (object format)', async () => {
      const item = buildServiceItem({
        env: { MY_VAR: 'my-value', DB_URL: 'postgres://localhost' },
      });

      await service.createServiceGroup(
        'dokkimi-run-inst1',
        'inst1',
        item,
        'api-gateway',
        'item-1',
        '127.0.0.11',
        configPaths,
        caBundlePaths,
        [],
      );

      const userCall = mockDockerClient.runContainer.mock.calls[1][0];
      expect(userCall.env.MY_VAR).toBe('my-value');
      expect(userCall.env.DB_URL).toBe('postgres://localhost');
      expect(userCall.env.HOSTNAME).toBe('0.0.0.0');
    });

    it('should merge user-defined env vars (array format)', async () => {
      const item = buildServiceItem({
        env: [
          { name: 'MY_VAR', value: 'my-value' },
          { name: 'OTHER', value: '123' },
        ] as any,
      });

      await service.createServiceGroup(
        'dokkimi-run-inst1',
        'inst1',
        item,
        'api-gateway',
        'item-1',
        '127.0.0.11',
        configPaths,
        caBundlePaths,
        [],
      );

      const userCall = mockDockerClient.runContainer.mock.calls[1][0];
      expect(userCall.env.MY_VAR).toBe('my-value');
      expect(userCall.env.OTHER).toBe('123');
    });

    it('should skip service with no image', async () => {
      const item = buildServiceItem({ image: null });

      const result = await service.createServiceGroup(
        'dokkimi-run-inst1',
        'inst1',
        item,
        'api-gateway',
        'item-1',
        '127.0.0.11',
        configPaths,
        caBundlePaths,
        [],
      );

      expect(result.userContainerId).toBeNull();
      expect(result.interceptorName).toBe('');
      expect(mockDockerClient.runContainer).not.toHaveBeenCalled();
    });

    it('should expose service port', async () => {
      const item = buildServiceItem({ port: 3000 });

      await service.createServiceGroup(
        'dokkimi-run-inst1',
        'inst1',
        item,
        'api-gateway',
        'item-1',
        '127.0.0.11',
        configPaths,
        caBundlePaths,
        [],
      );

      const userCall = mockDockerClient.runContainer.mock.calls[1][0];
      expect(userCall.exposedPorts).toContain(3000);
    });

    it('should mount local dev path when specified', async () => {
      const item = buildServiceItem({
        localDevPath: '/home/user/project/src',
        mountPath: '/app/src',
      });

      await service.createServiceGroup(
        'dokkimi-run-inst1',
        'inst1',
        item,
        'api-gateway',
        'item-1',
        '127.0.0.11',
        configPaths,
        caBundlePaths,
        [],
      );

      const userCall = mockDockerClient.runContainer.mock.calls[1][0];
      expect(userCall.binds).toContain('/home/user/project/src:/app/src');
    });

    it('should return userContainerId and interceptorName', async () => {
      const result = await service.createServiceGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildServiceItem(),
        'api-gateway',
        'item-1',
        '127.0.0.11',
        configPaths,
        caBundlePaths,
        [],
      );

      expect(result.userContainerId).toBe('container-id');
      expect(result.interceptorName).toBe('api-gateway-interceptor-inst1');
    });

    it('should pass database names to dnsmasq config', async () => {
      await service.createServiceGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildServiceItem(),
        'api-gateway',
        'item-1',
        '127.0.0.11',
        configPaths,
        caBundlePaths,
        ['postgres-db', 'redis-cache'],
      );

      expect(mockDeployConfig.buildDnsmasqConfig).toHaveBeenCalledWith(
        '127.0.0.11',
        ['postgres-db', 'redis-cache'],
        '172.18.0.5',
      );
    });
  });

  describe('createChromiumGroup', () => {
    it('should create 4 containers: interceptor, chromium, dnsmasq', async () => {
      await service.createChromiumGroup(
        'dokkimi-run-inst1',
        'inst1',
        '127.0.0.11',
        configPaths,
        caBundlePaths,
        [],
        'chromium-item-id',
      );

      expect(mockDockerClient.runContainer).toHaveBeenCalledTimes(3);
    });

    it('should give chromium the network alias', async () => {
      await service.createChromiumGroup(
        'dokkimi-run-inst1',
        'inst1',
        '127.0.0.11',
        configPaths,
        caBundlePaths,
        [],
        'chromium-item-id',
      );

      const chromiumCall = mockDockerClient.runContainer.mock.calls[1][0];
      expect(chromiumCall.networkAliases).toEqual(['chromium']);
      expect(chromiumCall.name).toBe('chromium-inst1');
    });

    it('should join chromium dnsmasq to chromium network namespace', async () => {
      await service.createChromiumGroup(
        'dokkimi-run-inst1',
        'inst1',
        '127.0.0.11',
        configPaths,
        caBundlePaths,
        [],
        'chromium-item-id',
      );

      const dnsmasqCall = mockDockerClient.runContainer.mock.calls[2][0];
      expect(dnsmasqCall.networkMode).toBe('container:chromium-inst1');
    });

    it('should mount CA bundles on chromium container', async () => {
      await service.createChromiumGroup(
        'dokkimi-run-inst1',
        'inst1',
        '127.0.0.11',
        configPaths,
        caBundlePaths,
        [],
        'chromium-item-id',
      );

      const chromiumCall = mockDockerClient.runContainer.mock.calls[1][0];
      expect(chromiumCall.env).toEqual(
        expect.objectContaining({
          NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/dokkimi-ca.crt',
          SSL_CERT_FILE: '/ca-bundle/ca-bundle.crt',
        }),
      );
      expect(chromiumCall.binds).toEqual(
        expect.arrayContaining(mockCaService.getServiceCaBinds()),
      );
    });

    it('should set chromium role labels', async () => {
      await service.createChromiumGroup(
        'dokkimi-run-inst1',
        'inst1',
        '127.0.0.11',
        configPaths,
        caBundlePaths,
        [],
        'chromium-item-id',
      );

      const chromiumCall = mockDockerClient.runContainer.mock.calls[1][0];
      expect(chromiumCall.labels['io.dokkimi.role']).toBe('chromium');

      const interceptorCall = mockDockerClient.runContainer.mock.calls[0][0];
      expect(interceptorCall.labels['io.dokkimi.role']).toBe(
        'chromium-interceptor',
      );
    });
  });
});
