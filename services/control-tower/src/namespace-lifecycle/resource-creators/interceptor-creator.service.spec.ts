import { DOKKIMI_IMAGES } from '../../constants/image-tags';

// Mock Kubernetes resource service before imports
jest.mock('../kubernetes/kubernetes-resource.service', () => ({
  KubernetesResourceService: jest.fn().mockImplementation(() => ({
    createServiceAccount: jest.fn(),
    createRole: jest.fn(),
    createRoleBinding: jest.fn(),
    createDeployment: jest.fn(),
    createService: jest.fn(),
  })),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { InterceptorCreatorService } from './interceptor-creator.service';
import { KubernetesResourceService } from '../kubernetes/kubernetes-resource.service';
import * as k8s from '@kubernetes/client-node';

describe('InterceptorCreatorService', () => {
  let service: InterceptorCreatorService;

  const mockK8sClient = {
    createServiceAccount: jest.fn(),
    createRole: jest.fn(),
    createRoleBinding: jest.fn(),
    createDeployment: jest.fn(),
    createService: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InterceptorCreatorService,
        {
          provide: KubernetesResourceService,
          useValue: mockK8sClient,
        },
      ],
    }).compile();

    service = module.get<InterceptorCreatorService>(InterceptorCreatorService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('should create interceptor deployment and service (no ingress)', async () => {
      mockK8sClient.createServiceAccount.mockResolvedValue(undefined);
      mockK8sClient.createRole.mockResolvedValue(undefined);
      mockK8sClient.createRoleBinding.mockResolvedValue(undefined);
      mockK8sClient.createDeployment.mockResolvedValue(undefined);
      mockK8sClient.createService.mockResolvedValue(undefined);

      await service.create('test-namespace', 'namespace-1', '10.96.0.10');

      // Verify RBAC resources are created first
      expect(mockK8sClient.createServiceAccount).toHaveBeenCalledTimes(1);
      expect(mockK8sClient.createRole).toHaveBeenCalledTimes(1);
      expect(mockK8sClient.createRoleBinding).toHaveBeenCalledTimes(1);

      // Verify deployment and service are created (no ingress)
      expect(mockK8sClient.createDeployment).toHaveBeenCalledTimes(1);
      expect(mockK8sClient.createService).toHaveBeenCalledTimes(1);

      // Verify RBAC resources are created before deployment
      const serviceAccountCallIndex =
        mockK8sClient.createServiceAccount.mock.invocationCallOrder[0];
      const roleCallIndex =
        mockK8sClient.createRole.mock.invocationCallOrder[0];
      const roleBindingCallIndex =
        mockK8sClient.createRoleBinding.mock.invocationCallOrder[0];
      const deploymentCallIndex =
        mockK8sClient.createDeployment.mock.invocationCallOrder[0];

      expect(serviceAccountCallIndex).toBeLessThan(deploymentCallIndex);
      expect(roleCallIndex).toBeLessThan(deploymentCallIndex);
      expect(roleBindingCallIndex).toBeLessThan(deploymentCallIndex);

      const deploymentCall = mockK8sClient.createDeployment.mock.calls[0] as [
        string,
        k8s.V1Deployment,
      ];
      expect(deploymentCall[0]).toBe('test-namespace');
      expect(deploymentCall[1].metadata?.name).toBe('interceptor');
      expect(
        deploymentCall[1].spec?.template?.spec?.containers?.[0]?.image,
      ).toBe(DOKKIMI_IMAGES.interceptor);

      const serviceCall = mockK8sClient.createService.mock.calls[0] as [
        string,
        k8s.V1Service,
      ];
      expect(serviceCall[0]).toBe('test-namespace');
      expect(serviceCall[1].metadata?.name).toBe('interceptor-service');
    });

    it('should set correct environment variables', async () => {
      mockK8sClient.createServiceAccount.mockResolvedValue(undefined);
      mockK8sClient.createRole.mockResolvedValue(undefined);
      mockK8sClient.createRoleBinding.mockResolvedValue(undefined);
      mockK8sClient.createDeployment.mockResolvedValue(undefined);
      mockK8sClient.createService.mockResolvedValue(undefined);

      await service.create('test-namespace', 'namespace-1', '10.96.0.10');

      const deploymentCall = mockK8sClient.createDeployment.mock.calls[0] as [
        string,
        k8s.V1Deployment,
      ];
      const deployment = deploymentCall[1];
      const env = deployment.spec?.template?.spec?.containers?.[0]?.env || [];

      // Shared interceptor should have empty ORIGIN to identify it as handling external traffic
      expect(env).toContainEqual({ name: 'ORIGIN', value: '' });
      expect(env).toContainEqual({ name: 'NAMESPACE', value: 'namespace-1' });
      expect(env).toContainEqual({
        name: 'CONTROL_TOWER_URL',
        value:
          process.env.CONTROL_TOWER_URL || 'http://host.docker.internal:19001',
      });
    });

    it('should handle errors', async () => {
      mockK8sClient.createServiceAccount.mockResolvedValue(undefined);
      mockK8sClient.createRole.mockResolvedValue(undefined);
      mockK8sClient.createRoleBinding.mockResolvedValue(undefined);
      mockK8sClient.createDeployment.mockRejectedValue(new Error('K8s error'));

      await expect(
        service.create('test-namespace', 'namespace-1', '10.96.0.10'),
      ).rejects.toThrow('K8s error');
    });

    it('should create RBAC resources with correct configuration', async () => {
      mockK8sClient.createServiceAccount.mockResolvedValue(undefined);
      mockK8sClient.createRole.mockResolvedValue(undefined);
      mockK8sClient.createRoleBinding.mockResolvedValue(undefined);
      mockK8sClient.createDeployment.mockResolvedValue(undefined);
      mockK8sClient.createService.mockResolvedValue(undefined);

      await service.create('test-namespace', 'namespace-1', '10.96.0.10');

      // Verify ServiceAccount
      const serviceAccountCall = mockK8sClient.createServiceAccount.mock
        .calls[0] as [string, k8s.V1ServiceAccount];
      expect(serviceAccountCall[0]).toBe('test-namespace');
      expect(serviceAccountCall[1].metadata?.name).toBe(
        'interceptor-service-account',
      );
      expect(serviceAccountCall[1].metadata?.namespace).toBe('test-namespace');

      // Verify Role
      const roleCall = mockK8sClient.createRole.mock.calls[0] as [
        string,
        k8s.V1Role,
      ];
      expect(roleCall[0]).toBe('test-namespace');
      expect(roleCall[1].metadata?.name).toBe('interceptor-configmap-reader');
      expect(roleCall[1].rules?.[0]?.resources).toEqual(['configmaps']);
      expect(roleCall[1].rules?.[0]?.verbs).toEqual(['get', 'list', 'watch']);
      expect(roleCall[1].rules?.[0]?.resourceNames).toEqual([
        'dokkimi-interceptor-config',
      ]);

      // Verify RoleBinding
      const roleBindingCall = mockK8sClient.createRoleBinding.mock.calls[0] as [
        string,
        k8s.V1RoleBinding,
      ];
      expect(roleBindingCall[0]).toBe('test-namespace');
      expect(roleBindingCall[1].metadata?.name).toBe(
        'interceptor-configmap-reader-binding',
      );
      expect(roleBindingCall[1].subjects?.[0]?.kind).toBe('ServiceAccount');
      expect(roleBindingCall[1].subjects?.[0]?.name).toBe(
        'interceptor-service-account',
      );
      expect(roleBindingCall[1].roleRef?.kind).toBe('Role');
      expect(roleBindingCall[1].roleRef?.name).toBe(
        'interceptor-configmap-reader',
      );
    });

    it('should set deployment replicas to 1', async () => {
      mockK8sClient.createServiceAccount.mockResolvedValue(undefined);
      mockK8sClient.createRole.mockResolvedValue(undefined);
      mockK8sClient.createRoleBinding.mockResolvedValue(undefined);
      mockK8sClient.createDeployment.mockResolvedValue(undefined);
      mockK8sClient.createService.mockResolvedValue(undefined);

      await service.create('test-namespace', 'namespace-1', '10.96.0.10');

      const deploymentCall = mockK8sClient.createDeployment.mock.calls[0] as [
        string,
        k8s.V1Deployment,
      ];
      const deployment = deploymentCall[1];

      expect(deployment.spec?.replicas).toBe(1);
    });

    it('should set terminationGracePeriodSeconds to 1 for fast shutdown', async () => {
      mockK8sClient.createServiceAccount.mockResolvedValue(undefined);
      mockK8sClient.createRole.mockResolvedValue(undefined);
      mockK8sClient.createRoleBinding.mockResolvedValue(undefined);
      mockK8sClient.createDeployment.mockResolvedValue(undefined);
      mockK8sClient.createService.mockResolvedValue(undefined);

      await service.create('test-namespace', 'namespace-1', '10.96.0.10');

      const deploymentCall = mockK8sClient.createDeployment.mock.calls[0] as [
        string,
        k8s.V1Deployment,
      ];
      const podSpec = deploymentCall[1].spec?.template?.spec;

      expect(podSpec?.terminationGracePeriodSeconds).toBe(1);
    });

    it('should set serviceAccountName on the pod spec', async () => {
      mockK8sClient.createServiceAccount.mockResolvedValue(undefined);
      mockK8sClient.createRole.mockResolvedValue(undefined);
      mockK8sClient.createRoleBinding.mockResolvedValue(undefined);
      mockK8sClient.createDeployment.mockResolvedValue(undefined);
      mockK8sClient.createService.mockResolvedValue(undefined);

      await service.create('test-namespace', 'namespace-1', '10.96.0.10');

      const deploymentCall = mockK8sClient.createDeployment.mock.calls[0] as [
        string,
        k8s.V1Deployment,
      ];
      const podSpec = deploymentCall[1].spec?.template?.spec;

      expect(podSpec?.serviceAccountName).toBe('interceptor-service-account');
    });

    it('should include instance-id label on the pod template', async () => {
      mockK8sClient.createServiceAccount.mockResolvedValue(undefined);
      mockK8sClient.createRole.mockResolvedValue(undefined);
      mockK8sClient.createRoleBinding.mockResolvedValue(undefined);
      mockK8sClient.createDeployment.mockResolvedValue(undefined);
      mockK8sClient.createService.mockResolvedValue(undefined);

      await service.create('my-ns', 'instance-abc', '10.96.0.10');

      const deploymentCall = mockK8sClient.createDeployment.mock.calls[0] as [
        string,
        k8s.V1Deployment,
      ];
      const podLabels = deploymentCall[1].spec?.template?.metadata?.labels;

      expect(podLabels).toEqual({
        app: 'interceptor',
        'dokkimi.io/instance-id': 'instance-abc',
      });
    });

    it('should set imagePullPolicy to IfNotPresent', async () => {
      mockK8sClient.createServiceAccount.mockResolvedValue(undefined);
      mockK8sClient.createRole.mockResolvedValue(undefined);
      mockK8sClient.createRoleBinding.mockResolvedValue(undefined);
      mockK8sClient.createDeployment.mockResolvedValue(undefined);
      mockK8sClient.createService.mockResolvedValue(undefined);

      await service.create('test-namespace', 'namespace-1', '10.96.0.10');

      const deploymentCall = mockK8sClient.createDeployment.mock.calls[0] as [
        string,
        k8s.V1Deployment,
      ];
      const container = deploymentCall[1].spec?.template?.spec?.containers?.[0];

      expect(container?.imagePullPolicy).toBe('IfNotPresent');
    });

    it('should configure the service with correct selector and port mapping', async () => {
      mockK8sClient.createServiceAccount.mockResolvedValue(undefined);
      mockK8sClient.createRole.mockResolvedValue(undefined);
      mockK8sClient.createRoleBinding.mockResolvedValue(undefined);
      mockK8sClient.createDeployment.mockResolvedValue(undefined);
      mockK8sClient.createService.mockResolvedValue(undefined);

      await service.create('test-namespace', 'namespace-1', '10.96.0.10');

      const serviceCall = mockK8sClient.createService.mock.calls[0] as [
        string,
        k8s.V1Service,
      ];
      const svc = serviceCall[1];

      expect(svc.spec?.selector).toEqual({ app: 'interceptor' });
      // Port and targetPort should match
      const port = svc.spec?.ports?.[0];
      expect(port?.port).toBe(port?.targetPort);
    });

    it('should set RoleBinding roleRef apiGroup to rbac.authorization.k8s.io', async () => {
      mockK8sClient.createServiceAccount.mockResolvedValue(undefined);
      mockK8sClient.createRole.mockResolvedValue(undefined);
      mockK8sClient.createRoleBinding.mockResolvedValue(undefined);
      mockK8sClient.createDeployment.mockResolvedValue(undefined);
      mockK8sClient.createService.mockResolvedValue(undefined);

      await service.create('test-namespace', 'namespace-1', '10.96.0.10');

      const roleBindingCall = mockK8sClient.createRoleBinding.mock.calls[0] as [
        string,
        k8s.V1RoleBinding,
      ];

      expect(roleBindingCall[1].roleRef?.apiGroup).toBe(
        'rbac.authorization.k8s.io',
      );
    });

    it('should propagate errors from service account creation', async () => {
      mockK8sClient.createServiceAccount.mockRejectedValue(
        new Error('RBAC creation failed'),
      );

      await expect(
        service.create('test-namespace', 'namespace-1', '10.96.0.10'),
      ).rejects.toThrow('RBAC creation failed');

      // Deployment should not have been attempted
      expect(mockK8sClient.createDeployment).not.toHaveBeenCalled();
    });

    it('should use different namespace and instanceId values correctly', async () => {
      mockK8sClient.createServiceAccount.mockResolvedValue(undefined);
      mockK8sClient.createRole.mockResolvedValue(undefined);
      mockK8sClient.createRoleBinding.mockResolvedValue(undefined);
      mockK8sClient.createDeployment.mockResolvedValue(undefined);
      mockK8sClient.createService.mockResolvedValue(undefined);

      await service.create(
        'dokkimi-prod-ns',
        'instance-xyz-789',
        '172.20.0.10',
      );

      // Verify namespace is propagated to all resources
      expect(mockK8sClient.createServiceAccount).toHaveBeenCalledWith(
        'dokkimi-prod-ns',
        expect.objectContaining({
          metadata: expect.objectContaining({ namespace: 'dokkimi-prod-ns' }),
        }),
      );
      expect(mockK8sClient.createRole).toHaveBeenCalledWith(
        'dokkimi-prod-ns',
        expect.objectContaining({
          metadata: expect.objectContaining({ namespace: 'dokkimi-prod-ns' }),
        }),
      );
      expect(mockK8sClient.createDeployment).toHaveBeenCalledWith(
        'dokkimi-prod-ns',
        expect.objectContaining({
          metadata: expect.objectContaining({ namespace: 'dokkimi-prod-ns' }),
        }),
      );
      expect(mockK8sClient.createService).toHaveBeenCalledWith(
        'dokkimi-prod-ns',
        expect.objectContaining({
          metadata: expect.objectContaining({ namespace: 'dokkimi-prod-ns' }),
        }),
      );

      // Verify instanceId is in the env vars
      const deploymentCall = mockK8sClient.createDeployment.mock.calls[0] as [
        string,
        k8s.V1Deployment,
      ];
      const env =
        deploymentCall[1].spec?.template?.spec?.containers?.[0]?.env || [];
      expect(env).toContainEqual({
        name: 'NAMESPACE',
        value: 'instance-xyz-789',
      });
    });
  });
});
