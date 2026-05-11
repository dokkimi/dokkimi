import { Test, TestingModule } from '@nestjs/testing';
import { ChromiumCreatorService } from './chromium-creator.service';
import { KubernetesResourceService } from '../kubernetes/kubernetes-resource.service';
import { ServiceInterceptorCreatorService } from './service-interceptor-creator.service';
import { ServiceDeploymentBuilderService } from '../builders/service-deployment-builder.service';

jest.mock('@dokkimi/config', () => ({
  getConfig: () => ({
    services: {
      chromium: { port: 9222 },
      interceptor: { port: 8080 },
      testAgent: { port: 8080 },
    },
    network: {
      dns: { nameserver: '10.0.0.10' },
    },
  }),
  buildInterceptorEnvVars: jest.fn(() => []),
}));

jest.mock('../../constants/image-tags', () => ({
  DOKKIMI_IMAGES: {
    dnsmasq: 'ghcr.io/dokkimi/dnsmasq:latest',
    interceptor: 'ghcr.io/dokkimi/interceptor:latest',
  },
  resolveBrowserImage: jest.fn(() => 'ghcr.io/dokkimi/chromium:latest'),
}));

describe('ChromiumCreatorService', () => {
  let service: ChromiumCreatorService;

  const mockK8sResource = {
    createDeployment: jest.fn().mockResolvedValue(undefined),
    createService: jest.fn().mockResolvedValue(undefined),
    createOrUpdateConfigMap: jest.fn().mockResolvedValue(undefined),
  };

  const mockInterceptorCreator = {
    create: jest.fn().mockResolvedValue({ clusterIP: '10.96.0.50' }),
  };

  const mockDeploymentBuilder = {
    buildDnsmasqConfigMapForService: jest.fn().mockReturnValue({
      metadata: { name: 'dokkimi-dnsmasq-config-chromium' },
      data: { 'dnsmasq.conf': 'config' },
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChromiumCreatorService,
        { provide: KubernetesResourceService, useValue: mockK8sResource },
        {
          provide: ServiceInterceptorCreatorService,
          useValue: mockInterceptorCreator,
        },
        {
          provide: ServiceDeploymentBuilderService,
          useValue: mockDeploymentBuilder,
        },
      ],
    }).compile();

    service = module.get(ChromiumCreatorService);
  });

  const defaultOptions = {
    k8sNamespace: 'dokkimi-inst-1',
    instanceId: 'inst-1',
    k8sDnsIP: '10.96.0.10',
    allServiceNames: ['svc-a', 'svc-b'],
    allServicePorts: [3000, 4000],
    databaseNames: ['db-1'],
  };

  it('should create interceptor, configmap, deployment, and service', async () => {
    await service.create(defaultOptions);

    expect(mockInterceptorCreator.create).toHaveBeenCalledWith(
      'dokkimi-inst-1',
      'inst-1',
      expect.objectContaining({ name: 'chromium', type: 'SERVICE' }),
      'chromium',
      '10.96.0.10',
      [3000, 4000],
    );
    expect(mockK8sResource.createOrUpdateConfigMap).toHaveBeenCalled();
    expect(mockK8sResource.createDeployment).toHaveBeenCalled();
    expect(mockK8sResource.createService).toHaveBeenCalled();
  });

  it('should include chromium container with correct args', async () => {
    await service.create(defaultOptions);

    const deployment = mockK8sResource.createDeployment.mock.calls[0][1];
    const chromiumContainer = deployment.spec!.template.spec!.containers.find(
      (c: any) => c.name === 'chromium',
    );

    expect(chromiumContainer).toBeDefined();
    expect(chromiumContainer.args).toContain('--disable-dev-shm-usage');
    expect(chromiumContainer.args).toContain('--ignore-certificate-errors');
  });

  it('should include dnsmasq sidecar container', async () => {
    await service.create(defaultOptions);

    const deployment = mockK8sResource.createDeployment.mock.calls[0][1];
    const dnsmasq = deployment.spec!.template.spec!.containers.find(
      (c: any) => c.name === 'dnsmasq',
    );

    expect(dnsmasq).toBeDefined();
    expect(dnsmasq.image).toBe('ghcr.io/dokkimi/dnsmasq:latest');
  });

  it('should set DNS policy to None with custom nameservers', async () => {
    await service.create(defaultOptions);

    const deployment = mockK8sResource.createDeployment.mock.calls[0][1];
    const podSpec = deployment.spec!.template.spec!;

    expect(podSpec.dnsPolicy).toBe('None');
    expect(podSpec.dnsConfig?.nameservers).toContain('10.0.0.10');
  });

  it('should set resource limits on chromium container', async () => {
    await service.create(defaultOptions);

    const deployment = mockK8sResource.createDeployment.mock.calls[0][1];
    const chromium = deployment.spec!.template.spec!.containers.find(
      (c: any) => c.name === 'chromium',
    );

    expect(chromium.resources.limits).toEqual({ cpu: '2', memory: '2Gi' });
    expect(chromium.resources.requests).toEqual({
      cpu: '500m',
      memory: '512Mi',
    });
  });

  it('should set readiness probe on chromium container', async () => {
    await service.create(defaultOptions);

    const deployment = mockK8sResource.createDeployment.mock.calls[0][1];
    const chromium = deployment.spec!.template.spec!.containers.find(
      (c: any) => c.name === 'chromium',
    );

    expect(chromium.readinessProbe.httpGet.path).toBe('/json/version');
  });

  it('should create service with port 80 and cdp port mappings', async () => {
    await service.create(defaultOptions);

    const svc = mockK8sResource.createService.mock.calls[0][1];
    const ports = svc.spec!.ports;
    const httpPort = ports.find((p: any) => p.name === 'http');
    const cdpPort = ports.find((p: any) => p.name === 'cdp');

    expect(httpPort.port).toBe(80);
    expect(httpPort.targetPort).toBe(9222);
    expect(cdpPort.port).toBe(9222);
  });

  it('should set terminationGracePeriodSeconds to 1', async () => {
    await service.create(defaultOptions);

    const deployment = mockK8sResource.createDeployment.mock.calls[0][1];
    expect(deployment.spec!.template.spec!.terminationGracePeriodSeconds).toBe(
      1,
    );
  });

  it('should set deployment metadata with correct name, namespace, and labels', async () => {
    await service.create(defaultOptions);

    const deployment = mockK8sResource.createDeployment.mock.calls[0][1];
    expect(deployment.metadata).toEqual({
      name: 'chromium',
      namespace: 'dokkimi-inst-1',
      labels: { app: 'chromium' },
    });
  });

  it('should set instance-id label on pod template', async () => {
    await service.create(defaultOptions);

    const deployment = mockK8sResource.createDeployment.mock.calls[0][1];
    const templateLabels = deployment.spec!.template.metadata!.labels;

    expect(templateLabels).toEqual({
      app: 'chromium',
      'dokkimi.io/instance-id': 'inst-1',
    });
  });

  it('should set deployment replicas to 1', async () => {
    await service.create(defaultOptions);

    const deployment = mockK8sResource.createDeployment.mock.calls[0][1];
    expect(deployment.spec!.replicas).toBe(1);
  });

  it('should set selector matchLabels to app: chromium', async () => {
    await service.create(defaultOptions);

    const deployment = mockK8sResource.createDeployment.mock.calls[0][1];
    expect(deployment.spec!.selector).toEqual({
      matchLabels: { app: 'chromium' },
    });
  });

  it('should configure DNS searches and options', async () => {
    await service.create(defaultOptions);

    const deployment = mockK8sResource.createDeployment.mock.calls[0][1];
    const dnsConfig = deployment.spec!.template.spec!.dnsConfig;

    expect(dnsConfig.searches).toEqual([
      'dokkimi-inst-1.svc.cluster.local',
      'svc.cluster.local',
      'cluster.local',
    ]);
    expect(dnsConfig.options).toEqual([
      { name: 'ndots', value: '2' },
      { name: 'timeout', value: '2' },
    ]);
  });

  it('should set chromium container image from resolveBrowserImage', async () => {
    await service.create(defaultOptions);

    const deployment = mockK8sResource.createDeployment.mock.calls[0][1];
    const chromium = deployment.spec!.template.spec!.containers.find(
      (c: any) => c.name === 'chromium',
    );

    expect(chromium.image).toBe('ghcr.io/dokkimi/chromium:latest');
    expect(chromium.imagePullPolicy).toBe('IfNotPresent');
  });

  it('should set chromium container port with name cdp', async () => {
    await service.create(defaultOptions);

    const deployment = mockK8sResource.createDeployment.mock.calls[0][1];
    const chromium = deployment.spec!.template.spec!.containers.find(
      (c: any) => c.name === 'chromium',
    );

    expect(chromium.ports).toEqual([{ containerPort: 9222, name: 'cdp' }]);
  });

  it('should set full readiness probe configuration', async () => {
    await service.create(defaultOptions);

    const deployment = mockK8sResource.createDeployment.mock.calls[0][1];
    const chromium = deployment.spec!.template.spec!.containers.find(
      (c: any) => c.name === 'chromium',
    );

    expect(chromium.readinessProbe).toEqual({
      httpGet: { path: '/json/version', port: 9222 },
      initialDelaySeconds: 2,
      periodSeconds: 3,
      timeoutSeconds: 2,
      failureThreshold: 5,
    });
  });

  it('should configure dnsmasq container with correct ports and volume mounts', async () => {
    await service.create(defaultOptions);

    const deployment = mockK8sResource.createDeployment.mock.calls[0][1];
    const dnsmasq = deployment.spec!.template.spec!.containers.find(
      (c: any) => c.name === 'dnsmasq',
    );

    expect(dnsmasq.args).toEqual(['-k']);
    expect(dnsmasq.ports).toEqual([
      { containerPort: 53, protocol: 'UDP' },
      { containerPort: 53, protocol: 'TCP' },
    ]);
    expect(dnsmasq.volumeMounts).toEqual([
      {
        name: 'dnsmasq-config',
        mountPath: '/etc/dnsmasq.conf',
        subPath: 'dnsmasq.conf',
      },
    ]);
  });

  it('should set resource limits on dnsmasq container', async () => {
    await service.create(defaultOptions);

    const deployment = mockK8sResource.createDeployment.mock.calls[0][1];
    const dnsmasq = deployment.spec!.template.spec!.containers.find(
      (c: any) => c.name === 'dnsmasq',
    );

    expect(dnsmasq.resources).toEqual({
      requests: { cpu: '50m', memory: '64Mi' },
      limits: { cpu: '200m', memory: '128Mi' },
    });
  });

  it('should configure volume referencing dnsmasq configmap', async () => {
    await service.create(defaultOptions);

    const deployment = mockK8sResource.createDeployment.mock.calls[0][1];
    const volumes = deployment.spec!.template.spec!.volumes;

    expect(volumes).toEqual([
      {
        name: 'dnsmasq-config',
        configMap: { name: 'dokkimi-dnsmasq-config-chromium' },
      },
    ]);
  });

  it('should set service metadata with correct name and namespace', async () => {
    await service.create(defaultOptions);

    const svc = mockK8sResource.createService.mock.calls[0][1];
    expect(svc.metadata).toEqual({
      name: 'chromium',
      namespace: 'dokkimi-inst-1',
    });
    expect(svc.spec!.selector).toEqual({ app: 'chromium' });
  });

  it('should pass browser config to resolveBrowserImage', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resolveBrowserImage } = require('../../constants/image-tags');
    await service.create({
      ...defaultOptions,
      browser: { version: '120.0.0.0' },
    });

    expect(resolveBrowserImage).toHaveBeenCalledWith({ version: '120.0.0.0' });
  });

  it('should call resolveBrowserImage with undefined when no browser config', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resolveBrowserImage } = require('../../constants/image-tags');
    await service.create(defaultOptions);

    expect(resolveBrowserImage).toHaveBeenCalledWith(undefined);
  });

  it('should pass correct arguments to buildDnsmasqConfigMapForService', async () => {
    await service.create(defaultOptions);

    expect(
      mockDeploymentBuilder.buildDnsmasqConfigMapForService,
    ).toHaveBeenCalledWith(
      'chromium',
      'dokkimi-inst-1',
      ['svc-a', 'svc-b'],
      '10.96.0.50',
      '10.96.0.10',
      ['db-1'],
    );
  });

  it('should pass chromiumItem with healthCheck and port to interceptor creator', async () => {
    await service.create(defaultOptions);

    const chromiumItem = mockInterceptorCreator.create.mock.calls[0][2];
    expect(chromiumItem).toEqual({
      name: 'chromium',
      k8sName: 'chromium',
      type: 'SERVICE',
      image: 'ghcr.io/dokkimi/chromium:latest',
      port: 9222,
      healthCheck: '/json/version',
    });
  });

  it('should pass k8sNamespace to both createDeployment and createService', async () => {
    await service.create(defaultOptions);

    expect(mockK8sResource.createDeployment).toHaveBeenCalledWith(
      'dokkimi-inst-1',
      expect.any(Object),
    );
    expect(mockK8sResource.createService).toHaveBeenCalledWith(
      'dokkimi-inst-1',
      expect.any(Object),
    );
  });

  it('should have exactly two containers in the deployment', async () => {
    await service.create(defaultOptions);

    const deployment = mockK8sResource.createDeployment.mock.calls[0][1];
    const containers = deployment.spec!.template.spec!.containers;
    expect(containers).toHaveLength(2);
    expect(containers.map((c: any) => c.name)).toEqual(['chromium', 'dnsmasq']);
  });
});
