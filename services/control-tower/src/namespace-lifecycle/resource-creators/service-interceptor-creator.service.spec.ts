import { Test, TestingModule } from '@nestjs/testing';
import { ServiceInterceptorCreatorService } from './service-interceptor-creator.service';
import { KubernetesResourceService } from '../kubernetes/kubernetes-resource.service';

jest.mock('@dokkimi/config', () => ({
  getConfig: () => ({
    services: {
      interceptor: { port: 8080 },
      testAgent: { port: 8080 },
    },
  }),
  buildInterceptorEnvVars: jest.fn(() => [
    { name: 'DOKKIMI_NAMESPACE', value: 'inst-1' },
  ]),
}));

jest.mock('../../constants/image-tags', () => ({
  DOKKIMI_IMAGES: {
    interceptor: 'ghcr.io/dokkimi/interceptor:latest',
  },
}));

describe('ServiceInterceptorCreatorService', () => {
  let service: ServiceInterceptorCreatorService;

  const mockK8sResource = {
    createService: jest.fn().mockResolvedValue(undefined),
    getService: jest.fn().mockResolvedValue({
      spec: { clusterIP: '10.96.1.100' },
    }),
    createDeployment: jest.fn().mockResolvedValue(undefined),
  };

  const defaultItem = {
    name: 'svc-a',
    k8sName: 'svc-a',
    type: 'SERVICE' as const,
    image: 'my-app:latest',
    port: 3000,
    healthCheck: '/health',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockK8sResource.createService.mockResolvedValue(undefined);
    mockK8sResource.getService.mockResolvedValue({
      spec: { clusterIP: '10.96.1.100' },
    });
    mockK8sResource.createDeployment.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ServiceInterceptorCreatorService,
        { provide: KubernetesResourceService, useValue: mockK8sResource },
      ],
    }).compile();

    service = module.get(ServiceInterceptorCreatorService);
  });

  it('should create service, read clusterIP, create deployment, and return clusterIP', async () => {
    const result = await service.create(
      'dokkimi-inst-1',
      'inst-1',
      defaultItem,
      'item-1',
      '10.96.0.10',
      [3000, 4000],
    );

    expect(result).toEqual({ clusterIP: '10.96.1.100' });

    expect(mockK8sResource.createService).toHaveBeenCalledWith(
      'dokkimi-inst-1',
      expect.objectContaining({
        metadata: expect.objectContaining({
          name: 'svc-a-interceptor',
        }),
      }),
    );
    expect(mockK8sResource.getService).toHaveBeenCalledWith(
      'dokkimi-inst-1',
      'svc-a-interceptor',
    );
    expect(mockK8sResource.createDeployment).toHaveBeenCalled();
  });

  it('should throw when clusterIP is not assigned', async () => {
    mockK8sResource.getService.mockResolvedValue({ spec: {} });

    await expect(
      service.create(
        'dokkimi-inst-1',
        'inst-1',
        defaultItem,
        'item-1',
        '10.96.0.10',
        [3000],
      ),
    ).rejects.toThrow('Failed to get ClusterIP');
  });

  it('should map all service ports plus 80 and 443', async () => {
    await service.create(
      'dokkimi-inst-1',
      'inst-1',
      defaultItem,
      'item-1',
      '10.96.0.10',
      [3000, 4000],
    );

    const svc = mockK8sResource.createService.mock.calls[0][1];
    const portNumbers = svc.spec.ports.map((p: any) => p.port);

    expect(portNumbers).toContain(80);
    expect(portNumbers).toContain(443);
    expect(portNumbers).toContain(3000);
    expect(portNumbers).toContain(4000);
  });

  it('should map port 443 to targetPort 443 for HTTPS', async () => {
    await service.create(
      'dokkimi-inst-1',
      'inst-1',
      defaultItem,
      'item-1',
      '10.96.0.10',
      [3000],
    );

    const svc = mockK8sResource.createService.mock.calls[0][1];
    const httpsPort = svc.spec.ports.find((p: any) => p.port === 443);
    expect(httpsPort.targetPort).toBe(443);
  });

  it('should map non-443 ports to interceptor port', async () => {
    await service.create(
      'dokkimi-inst-1',
      'inst-1',
      defaultItem,
      'item-1',
      '10.96.0.10',
      [3000],
    );

    const svc = mockK8sResource.createService.mock.calls[0][1];
    const port80 = svc.spec.ports.find((p: any) => p.port === 80);
    expect(port80.targetPort).toBe(8080);
  });

  it('should include CA volume mount in deployment', async () => {
    await service.create(
      'dokkimi-inst-1',
      'inst-1',
      defaultItem,
      'item-1',
      '10.96.0.10',
      [3000],
    );

    const deployment = mockK8sResource.createDeployment.mock.calls[0][1];
    const volumes = deployment.spec.template.spec.volumes;
    const caVolume = volumes.find((v: any) => v.name === 'dokkimi-ca');
    expect(caVolume).toBeDefined();
    expect(caVolume.secret.secretName).toBe('dokkimi-ca');

    const container = deployment.spec.template.spec.containers[0];
    const caMount = container.volumeMounts.find(
      (m: any) => m.name === 'dokkimi-ca',
    );
    expect(caMount.mountPath).toBe('/etc/dokkimi/ca');
    expect(caMount.readOnly).toBe(true);
  });

  it('should include CA cert path env vars', async () => {
    await service.create(
      'dokkimi-inst-1',
      'inst-1',
      defaultItem,
      'item-1',
      '10.96.0.10',
      [3000],
    );

    const deployment = mockK8sResource.createDeployment.mock.calls[0][1];
    const envVars = deployment.spec.template.spec.containers[0].env;
    const certPath = envVars.find(
      (e: any) => e.name === 'DOKKIMI_CA_CERT_PATH',
    );
    const keyPath = envVars.find((e: any) => e.name === 'DOKKIMI_CA_KEY_PATH');

    expect(certPath.value).toBe('/etc/dokkimi/ca/tls.crt');
    expect(keyPath.value).toBe('/etc/dokkimi/ca/tls.key');
  });

  it('should set readiness and liveness probes on /health', async () => {
    await service.create(
      'dokkimi-inst-1',
      'inst-1',
      defaultItem,
      'item-1',
      '10.96.0.10',
      [3000],
    );

    const deployment = mockK8sResource.createDeployment.mock.calls[0][1];
    const container = deployment.spec.template.spec.containers[0];

    expect(container.readinessProbe.httpGet.path).toBe('/health');
    expect(container.readinessProbe.initialDelaySeconds).toBe(5);
    expect(container.livenessProbe.httpGet.path).toBe('/health');
    expect(container.livenessProbe.initialDelaySeconds).toBe(10);
  });

  it('should set serviceAccountName to interceptor-service-account', async () => {
    await service.create(
      'dokkimi-inst-1',
      'inst-1',
      defaultItem,
      'item-1',
      '10.96.0.10',
      [3000],
    );

    const deployment = mockK8sResource.createDeployment.mock.calls[0][1];
    expect(deployment.spec.template.spec.serviceAccountName).toBe(
      'interceptor-service-account',
    );
  });

  it('should re-throw errors from K8s resource creation', async () => {
    mockK8sResource.createService.mockRejectedValue(
      new Error('K8s connection refused'),
    );

    await expect(
      service.create(
        'dokkimi-inst-1',
        'inst-1',
        defaultItem,
        'item-1',
        '10.96.0.10',
        [3000],
      ),
    ).rejects.toThrow('K8s connection refused');
  });

  it('should deduplicate port 80 when it appears in allServicePorts', async () => {
    await service.create(
      'dokkimi-inst-1',
      'inst-1',
      defaultItem,
      'item-1',
      '10.96.0.10',
      [80, 3000],
    );

    const svc = mockK8sResource.createService.mock.calls[0][1];
    const port80Entries = svc.spec.ports.filter((p: any) => p.port === 80);
    expect(port80Entries).toHaveLength(1);
  });

  it('should handle empty allServicePorts array', async () => {
    await service.create(
      'dokkimi-inst-1',
      'inst-1',
      defaultItem,
      'item-1',
      '10.96.0.10',
      [],
    );

    const svc = mockK8sResource.createService.mock.calls[0][1];
    const portNumbers = svc.spec.ports.map((p: any) => p.port);
    // Should still have port 80 and 443
    expect(portNumbers).toContain(80);
    expect(portNumbers).toContain(443);
    expect(portNumbers).toHaveLength(2);
  });

  it('should throw when spec is missing from getService response', async () => {
    mockK8sResource.getService.mockResolvedValue({});

    await expect(
      service.create(
        'dokkimi-inst-1',
        'inst-1',
        defaultItem,
        'item-1',
        '10.96.0.10',
        [3000],
      ),
    ).rejects.toThrow('Failed to get ClusterIP');
  });

  it('should not call createDeployment when getService fails', async () => {
    mockK8sResource.getService.mockRejectedValue(
      new Error('Service not found'),
    );

    await expect(
      service.create(
        'dokkimi-inst-1',
        'inst-1',
        defaultItem,
        'item-1',
        '10.96.0.10',
        [3000],
      ),
    ).rejects.toThrow('Service not found');

    expect(mockK8sResource.createDeployment).not.toHaveBeenCalled();
  });

  it('should re-throw errors from createDeployment', async () => {
    mockK8sResource.createDeployment.mockRejectedValue(
      new Error('Deployment quota exceeded'),
    );

    await expect(
      service.create(
        'dokkimi-inst-1',
        'inst-1',
        defaultItem,
        'item-1',
        '10.96.0.10',
        [3000],
      ),
    ).rejects.toThrow('Deployment quota exceeded');
  });

  it('should set deployment labels with instance-id', async () => {
    await service.create(
      'dokkimi-inst-1',
      'inst-42',
      defaultItem,
      'item-1',
      '10.96.0.10',
      [3000],
    );

    const deployment = mockK8sResource.createDeployment.mock.calls[0][1];
    const podLabels = deployment.spec.template.metadata.labels;
    expect(podLabels['dokkimi.io/instance-id']).toBe('inst-42');
    expect(podLabels.app).toBe('svc-a-interceptor');
  });

  it('should use correct interceptor image', async () => {
    await service.create(
      'dokkimi-inst-1',
      'inst-1',
      defaultItem,
      'item-1',
      '10.96.0.10',
      [3000],
    );

    const deployment = mockK8sResource.createDeployment.mock.calls[0][1];
    const container = deployment.spec.template.spec.containers[0];
    expect(container.image).toBe('ghcr.io/dokkimi/interceptor:latest');
    expect(container.imagePullPolicy).toBe('IfNotPresent');
  });

  it('should pass item.name as origin to buildInterceptorEnvVars', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildInterceptorEnvVars } = require('@dokkimi/config');

    await service.create(
      'dokkimi-inst-1',
      'inst-1',
      defaultItem,
      'item-1',
      '10.96.0.10',
      [3000],
    );

    expect(buildInterceptorEnvVars).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        origin: 'svc-a',
        instanceItemName: 'svc-a',
        namespace: 'inst-1',
        k8sNamespace: 'dokkimi-inst-1',
        k8sDnsIP: '10.96.0.10',
        namespaceItemId: 'item-1',
      }),
    );
  });

  it('should pass undefined healthCheckEndpoint when item.healthCheck is falsy', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildInterceptorEnvVars } = require('@dokkimi/config');
    const itemNoHealth = { ...defaultItem, healthCheck: null };

    await service.create(
      'dokkimi-inst-1',
      'inst-1',
      itemNoHealth,
      'item-1',
      '10.96.0.10',
      [3000],
    );

    expect(buildInterceptorEnvVars).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        healthCheckEndpoint: undefined,
      }),
    );
  });
});
