import { Test, TestingModule } from '@nestjs/testing';
import { InstanceStatus, ItemStatus } from '@prisma/client';
import { NamespaceDeployerService } from './namespace-deployer.service';
import { DeployerConfigMapService } from './deployer-configmap.service';
import { KubernetesClientService } from '../namespace-lifecycle/kubernetes/kubernetes-client.service';
import { InterceptorCreatorService } from '../namespace-lifecycle/resource-creators/interceptor-creator.service';
import { ServiceInterceptorCreatorService } from '../namespace-lifecycle/resource-creators/service-interceptor-creator.service';
import { TestAgentCreatorService } from '../namespace-lifecycle/resource-creators/test-agent-creator.service';
import { ChromiumCreatorService } from '../namespace-lifecycle/resource-creators/chromium-creator.service';
import { InstanceItemCreatorService } from '../namespace-lifecycle/resource-creators/instance-item-creator.service';
import { InstanceItemService } from '../namespace/instance-item.service';
import { NamespaceInstanceService } from '../namespace/namespace-instance.service';
import { DokkimiCaService } from '../namespace-lifecycle/dokkimi-ca.service';
import { RegistryCredentialsService } from '../namespace-lifecycle/registry-credentials.service';
import { TelemetryService } from '../telemetry/telemetry.service';
import { DeploymentContext } from './deployment-context.types';

describe('NamespaceDeployerService', () => {
  let service: NamespaceDeployerService;

  const mockK8sClient = {
    createNamespace: jest.fn(),
    getKubeDnsClusterIP: jest.fn().mockResolvedValue('10.96.0.10'),
  };

  const mockInterceptorCreator = { create: jest.fn() };
  const mockServiceInterceptorCreator = {
    create: jest.fn().mockResolvedValue({ clusterIP: '10.96.1.1' }),
  };
  const mockTestAgentCreator = { create: jest.fn() };
  const mockChromiumCreator = { create: jest.fn() };
  const mockInstanceItemCreator = {
    createService: jest.fn(),
    createDatabase: jest.fn(),
  };

  const mockInstanceItemService = {
    updateInstanceItemK8sName: jest.fn(),
    updateInstanceItemStatus: jest.fn(),
    updateInstanceItemReadiness: jest.fn(),
  };

  const mockInstanceService = {
    updateInstanceStatus: jest.fn(),
    updateInstanceK8sNamespace: jest.fn(),
  };

  const mockDeployerConfigMap = { buildAndApply: jest.fn() };

  const mockCaService = { copyCAToNamespace: jest.fn() };
  const mockRegistryCredentials = { copyToNamespace: jest.fn() };

  const mockTelemetry = {
    track: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NamespaceDeployerService,
        { provide: KubernetesClientService, useValue: mockK8sClient },
        {
          provide: InterceptorCreatorService,
          useValue: mockInterceptorCreator,
        },
        {
          provide: ServiceInterceptorCreatorService,
          useValue: mockServiceInterceptorCreator,
        },
        { provide: TestAgentCreatorService, useValue: mockTestAgentCreator },
        { provide: ChromiumCreatorService, useValue: mockChromiumCreator },
        {
          provide: InstanceItemCreatorService,
          useValue: mockInstanceItemCreator,
        },
        { provide: InstanceItemService, useValue: mockInstanceItemService },
        { provide: NamespaceInstanceService, useValue: mockInstanceService },
        { provide: DeployerConfigMapService, useValue: mockDeployerConfigMap },
        { provide: DokkimiCaService, useValue: mockCaService },
        {
          provide: RegistryCredentialsService,
          useValue: mockRegistryCredentials,
        },
        { provide: TelemetryService, useValue: mockTelemetry },
      ],
    }).compile();

    service = module.get<NamespaceDeployerService>(NamespaceDeployerService);
    jest.clearAllMocks();
    mockK8sClient.createNamespace.mockResolvedValue(undefined);
    mockK8sClient.getKubeDnsClusterIP.mockResolvedValue('10.96.0.10');
    mockServiceInterceptorCreator.create.mockResolvedValue({
      clusterIP: '10.96.1.1',
    });
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('deploy', () => {
    const baseCtx: DeploymentContext = {
      runId: 'run-1',
      instanceId: 'inst-1',
      k8sNamespaceName: 'dokkimi-inst-1',
      instanceItemIds: new Map([
        ['api-service', 'item-1'],
        ['users-db', 'item-2'],
      ]),
      definition: {
        name: 'test-def',
        items: [
          {
            name: 'api-service',
            type: 'SERVICE',
            image: 'api:latest',
            port: 8080,
          },
          {
            name: 'users-db',
            type: 'DATABASE',
            database: 'postgres',
          },
        ],
      },
    };

    it('should set instance to STARTING then RUNNING', async () => {
      await service.deploy(baseCtx);

      expect(mockInstanceService.updateInstanceStatus).toHaveBeenCalledWith(
        'inst-1',
        InstanceStatus.STARTING,
      );
      expect(
        mockInstanceService.updateInstanceK8sNamespace,
      ).toHaveBeenCalledWith('inst-1', 'dokkimi-inst-1');

      // RUNNING should be the last status update
      const statusCalls = mockInstanceService.updateInstanceStatus.mock.calls;
      expect(statusCalls[statusCalls.length - 1]).toEqual([
        'inst-1',
        InstanceStatus.RUNNING,
      ]);
    });

    it('should create K8s namespace and infrastructure', async () => {
      await service.deploy(baseCtx);

      expect(mockK8sClient.createNamespace).toHaveBeenCalledWith(
        'dokkimi-inst-1',
      );
      expect(mockDeployerConfigMap.buildAndApply).toHaveBeenCalledWith(baseCtx);
      expect(mockInterceptorCreator.create).toHaveBeenCalledWith(
        'dokkimi-inst-1',
        'inst-1',
        '10.96.0.10',
      );
      expect(mockTestAgentCreator.create).toHaveBeenCalledWith(
        'dokkimi-inst-1',
        'inst-1',
        { hasUiSteps: false },
      );
    });

    it('should deploy service items with interceptor', async () => {
      await service.deploy(baseCtx);

      expect(
        mockInstanceItemService.updateInstanceItemK8sName,
      ).toHaveBeenCalledWith('item-1', 'api-service');
      expect(
        mockInstanceItemService.updateInstanceItemStatus,
      ).toHaveBeenCalledWith('item-1', ItemStatus.STARTING);
      expect(mockServiceInterceptorCreator.create).toHaveBeenCalledWith(
        'dokkimi-inst-1',
        'inst-1',
        expect.objectContaining({
          name: 'api-service',
          k8sName: 'api-service',
        }),
        'item-1',
        '10.96.0.10',
        [8080], // allServicePorts
      );
      expect(mockInstanceItemCreator.createService).toHaveBeenCalledWith(
        'dokkimi-inst-1',
        'inst-1',
        expect.objectContaining({ name: 'api-service' }),
        '10.96.0.10',
        'item-1',
        '10.96.1.1',
        ['api-service'],
        ['users-db'],
      );
    });

    it('should deploy database items', async () => {
      await service.deploy(baseCtx);

      expect(mockInstanceItemCreator.createDatabase).toHaveBeenCalledWith(
        'dokkimi-inst-1',
        'inst-1',
        expect.objectContaining({ name: 'users-db', k8sName: 'users-db' }),
        'item-2',
      );
    });

    it('should mark mock items as READY', async () => {
      const ctxWithMock: DeploymentContext = {
        ...baseCtx,
        instanceItemIds: new Map([['stripe-mock', 'item-3']]),
        definition: {
          name: 'test-def',
          items: [
            {
              name: 'stripe-mock',
              type: 'MOCK',
              mockMethod: 'GET',
              mockTarget: '*',
            },
          ],
        },
      };

      await service.deploy(ctxWithMock);

      expect(
        mockInstanceItemService.updateInstanceItemK8sName,
      ).toHaveBeenCalledWith('item-3', 'stripe-mock');
      expect(
        mockInstanceItemService.updateInstanceItemStatus,
      ).toHaveBeenCalledWith('item-3', ItemStatus.STARTING);
      expect(
        mockInstanceItemService.updateInstanceItemReadiness,
      ).toHaveBeenCalledWith('item-3', 'READY');

      // Mock items should not be deployed as services or databases
      expect(mockInstanceItemCreator.createService).not.toHaveBeenCalled();
      expect(mockInstanceItemCreator.createDatabase).not.toHaveBeenCalled();
    });

    it('should always create test-agent regardless of tests', async () => {
      // No tests in definition
      await service.deploy(baseCtx);
      expect(mockTestAgentCreator.create).toHaveBeenCalledTimes(1);
    });

    it('should set instance to FAILED on error and rethrow', async () => {
      const error = new Error('K8s namespace creation failed');
      mockK8sClient.createNamespace.mockRejectedValue(error);

      await expect(service.deploy(baseCtx)).rejects.toThrow(
        'K8s namespace creation failed',
      );

      expect(mockInstanceService.updateInstanceStatus).toHaveBeenCalledWith(
        'inst-1',
        InstanceStatus.FAILED,
      );
    });

    it('should copy CA to namespace after creating it', async () => {
      await service.deploy(baseCtx);

      expect(mockCaService.copyCAToNamespace).toHaveBeenCalledWith(
        'dokkimi-inst-1',
      );
    });

    it('should copy registry credentials to namespace', async () => {
      await service.deploy(baseCtx);

      expect(mockRegistryCredentials.copyToNamespace).toHaveBeenCalledWith(
        'run-1',
        'dokkimi-inst-1',
      );
    });

    it('should skip items with no instanceItemId and not throw', async () => {
      const ctxMissingId: DeploymentContext = {
        ...baseCtx,
        instanceItemIds: new Map([['api-service', 'item-1']]),
        // users-db has no entry in instanceItemIds
      };

      await service.deploy(ctxMissingId);

      // api-service should still be deployed
      expect(mockInstanceItemCreator.createService).toHaveBeenCalledTimes(1);
      // users-db should be skipped entirely
      expect(mockInstanceItemCreator.createDatabase).not.toHaveBeenCalled();
    });

    it('should skip mock items with no instanceItemId silently', async () => {
      const ctxMockNoId: DeploymentContext = {
        ...baseCtx,
        instanceItemIds: new Map(), // no IDs at all
        definition: {
          name: 'test-def',
          items: [
            {
              name: 'stripe-mock',
              type: 'MOCK',
              mockMethod: 'GET',
              mockTarget: '*',
            },
          ],
        },
      };

      await service.deploy(ctxMockNoId);

      expect(
        mockInstanceItemService.updateInstanceItemK8sName,
      ).not.toHaveBeenCalled();
      expect(
        mockInstanceItemService.updateInstanceItemReadiness,
      ).not.toHaveBeenCalled();
    });

    it('should deploy chromium when definition has UI steps', async () => {
      const ctxWithUi: DeploymentContext = {
        ...baseCtx,
        definition: {
          ...baseCtx.definition,
          tests: [
            {
              name: 'ui-test',
              steps: [
                { action: { type: 'ui', command: 'click', selector: '#btn' } },
              ],
            },
          ] as any,
        },
      };

      await service.deploy(ctxWithUi);

      expect(mockChromiumCreator.create).toHaveBeenCalledWith(
        expect.objectContaining({
          k8sNamespace: 'dokkimi-inst-1',
          instanceId: 'inst-1',
          k8sDnsIP: '10.96.0.10',
          allServiceNames: ['api-service'],
          allServicePorts: [8080],
          databaseNames: ['users-db'],
        }),
      );
    });

    it('should not deploy chromium when no UI steps exist', async () => {
      await service.deploy(baseCtx);

      expect(mockChromiumCreator.create).not.toHaveBeenCalled();
    });

    it('should pass hasUiSteps=true to test-agent when UI steps exist', async () => {
      const ctxWithUi: DeploymentContext = {
        ...baseCtx,
        definition: {
          ...baseCtx.definition,
          tests: [
            {
              name: 'ui-test',
              steps: [
                { action: { type: 'ui', command: 'click', selector: '#btn' } },
              ],
            },
          ] as any,
        },
      };

      await service.deploy(ctxWithUi);

      expect(mockTestAgentCreator.create).toHaveBeenCalledWith(
        'dokkimi-inst-1',
        'inst-1',
        { hasUiSteps: true },
      );
    });

    it('should track telemetry for chromium deployment', async () => {
      const ctxWithUi: DeploymentContext = {
        ...baseCtx,
        definition: {
          ...baseCtx.definition,
          tests: [
            {
              name: 'ui-test',
              steps: [
                { action: { type: 'ui', command: 'click', selector: '#btn' } },
              ],
            },
          ] as any,
        },
      };

      await service.deploy(ctxWithUi);

      expect(mockTelemetry.track).toHaveBeenCalledWith(
        'ct_chromium_deployed',
        expect.objectContaining({
          duration_ms: expect.any(Number),
          browser_version: 'default',
        }),
      );
    });

    it('should pass browser version from config to chromium telemetry', async () => {
      const ctxWithBrowser: DeploymentContext = {
        ...baseCtx,
        definition: {
          ...baseCtx.definition,
          config: { browser: { version: '120.0' } },
          tests: [
            {
              name: 'ui-test',
              steps: [
                { action: { type: 'ui', command: 'click', selector: '#btn' } },
              ],
            },
          ] as any,
        },
      };

      await service.deploy(ctxWithBrowser);

      expect(mockTelemetry.track).toHaveBeenCalledWith(
        'ct_chromium_deployed',
        expect.objectContaining({
          browser_version: '120.0',
        }),
      );
    });

    it('should pass browser config to chromium creator', async () => {
      const ctxWithBrowser: DeploymentContext = {
        ...baseCtx,
        definition: {
          ...baseCtx.definition,
          config: { browser: { version: '120.0' } },
          tests: [
            {
              name: 'ui-test',
              steps: [
                { action: { type: 'ui', command: 'click', selector: '#btn' } },
              ],
            },
          ] as any,
        },
      };

      await service.deploy(ctxWithBrowser);

      expect(mockChromiumCreator.create).toHaveBeenCalledWith(
        expect.objectContaining({
          browser: { version: '120.0' },
        }),
      );
    });

    it('should track telemetry on deploy failure', async () => {
      const error = new Error('deploy boom');
      mockK8sClient.createNamespace.mockRejectedValue(error);

      await expect(service.deploy(baseCtx)).rejects.toThrow('deploy boom');

      expect(mockTelemetry.track).toHaveBeenCalledWith(
        'ct_deploy_failed',
        expect.objectContaining({
          duration_ms: expect.any(Number),
          error_type: 'Error',
          has_ui_steps: false,
        }),
      );
    });

    it('should handle non-Error thrown objects in failure telemetry', async () => {
      mockK8sClient.createNamespace.mockRejectedValue('string error');

      await expect(service.deploy(baseCtx)).rejects.toBe('string error');

      expect(mockTelemetry.track).toHaveBeenCalledWith(
        'ct_deploy_failed',
        expect.objectContaining({
          error_type: 'Unknown',
        }),
      );
    });

    it('should handle definition with only services (no databases)', async () => {
      const ctxServicesOnly: DeploymentContext = {
        ...baseCtx,
        instanceItemIds: new Map([['api-service', 'item-1']]),
        definition: {
          name: 'test-def',
          items: [
            {
              name: 'api-service',
              type: 'SERVICE',
              image: 'api:latest',
              port: 8080,
            },
          ],
        },
      };

      await service.deploy(ctxServicesOnly);

      expect(mockInstanceItemCreator.createService).toHaveBeenCalledWith(
        'dokkimi-inst-1',
        'inst-1',
        expect.objectContaining({ name: 'api-service' }),
        '10.96.0.10',
        'item-1',
        '10.96.1.1',
        ['api-service'],
        [], // empty databaseNames
      );
      expect(mockInstanceItemCreator.createDatabase).not.toHaveBeenCalled();
    });

    it('should handle definition with only databases (no services)', async () => {
      const ctxDbOnly: DeploymentContext = {
        ...baseCtx,
        instanceItemIds: new Map([['users-db', 'item-2']]),
        definition: {
          name: 'test-def',
          items: [
            {
              name: 'users-db',
              type: 'DATABASE',
              database: 'postgres',
            },
          ],
        },
      };

      await service.deploy(ctxDbOnly);

      expect(mockInstanceItemCreator.createDatabase).toHaveBeenCalledTimes(1);
      expect(mockInstanceItemCreator.createService).not.toHaveBeenCalled();
      expect(mockServiceInterceptorCreator.create).not.toHaveBeenCalled();
    });

    it('should filter out null/undefined ports from allServicePorts', async () => {
      const ctxMixedPorts: DeploymentContext = {
        ...baseCtx,
        instanceItemIds: new Map([
          ['svc-a', 'item-a'],
          ['svc-b', 'item-b'],
        ]),
        definition: {
          name: 'test-def',
          items: [
            {
              name: 'svc-a',
              type: 'SERVICE',
              image: 'a:latest',
              port: 3000,
            },
            {
              name: 'svc-b',
              type: 'SERVICE',
              image: 'b:latest',
              port: null,
            },
          ],
        },
      };

      await service.deploy(ctxMixedPorts);

      // allServicePorts should only contain 3000, not null
      expect(mockServiceInterceptorCreator.create).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Object),
        expect.any(String),
        expect.any(String),
        [3000], // null port filtered out
      );
    });

    it('should handle empty items list', async () => {
      const ctxEmpty: DeploymentContext = {
        ...baseCtx,
        instanceItemIds: new Map(),
        definition: {
          name: 'test-def',
          items: [],
        },
      };

      await service.deploy(ctxEmpty);

      expect(mockInstanceItemCreator.createService).not.toHaveBeenCalled();
      expect(mockInstanceItemCreator.createDatabase).not.toHaveBeenCalled();
      expect(
        mockInstanceItemService.updateInstanceItemK8sName,
      ).not.toHaveBeenCalled();
      expect(mockInstanceService.updateInstanceStatus).toHaveBeenCalledWith(
        'inst-1',
        InstanceStatus.RUNNING,
      );
    });
  });
});
