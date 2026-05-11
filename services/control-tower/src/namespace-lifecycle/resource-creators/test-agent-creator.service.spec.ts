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
import * as k8s from '@kubernetes/client-node';
import { TestAgentCreatorService } from './test-agent-creator.service';
import { KubernetesResourceService } from '../kubernetes/kubernetes-resource.service';

describe('TestAgentCreatorService', () => {
  let service: TestAgentCreatorService;
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
        TestAgentCreatorService,
        { provide: KubernetesResourceService, useValue: mockK8sClient },
      ],
    }).compile();

    service = module.get<TestAgentCreatorService>(TestAgentCreatorService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  /** Convenience: extract the Deployment spec passed to createDeployment. */
  function deployedSpec(): k8s.V1Deployment {
    expect(mockK8sClient.createDeployment).toHaveBeenCalledTimes(1);
    return mockK8sClient.createDeployment.mock.calls[0][1] as k8s.V1Deployment;
  }

  function mainContainer(dep: k8s.V1Deployment): k8s.V1Container {
    const containers = dep.spec!.template!.spec!.containers;
    const c = containers.find((x) => x.name === 'test-agent');
    if (!c) {
      throw new Error('test-agent container missing');
    }
    return c;
  }

  describe('create — default (no UI steps)', () => {
    beforeEach(async () => {
      mockK8sClient.createServiceAccount.mockResolvedValue(undefined);
      mockK8sClient.createRole.mockResolvedValue(undefined);
      mockK8sClient.createRoleBinding.mockResolvedValue(undefined);
      mockK8sClient.createDeployment.mockResolvedValue(undefined);
      mockK8sClient.createService.mockResolvedValue(undefined);
      await service.create('test-ns', 'inst-1');
    });

    it('creates RBAC + deployment + service exactly once each', () => {
      expect(mockK8sClient.createServiceAccount).toHaveBeenCalledTimes(1);
      expect(mockK8sClient.createRole).toHaveBeenCalledTimes(1);
      expect(mockK8sClient.createRoleBinding).toHaveBeenCalledTimes(1);
      expect(mockK8sClient.createDeployment).toHaveBeenCalledTimes(1);
      expect(mockK8sClient.createService).toHaveBeenCalledTimes(1);
    });

    it('deploys only the test-agent container', () => {
      const dep = deployedSpec();
      const containers = dep.spec!.template!.spec!.containers;
      expect(containers).toHaveLength(1);
      expect(containers[0].name).toBe('test-agent');
    });

    it('does not set BROWSER_URL on the test-agent container', () => {
      const env = mainContainer(deployedSpec()).env ?? [];
      const browserURL = env.find((e) => e.name === 'BROWSER_URL');
      expect(browserURL).toBeUndefined();
    });
  });

  describe('create — hasUiSteps=true', () => {
    beforeEach(async () => {
      mockK8sClient.createServiceAccount.mockResolvedValue(undefined);
      mockK8sClient.createRole.mockResolvedValue(undefined);
      mockK8sClient.createRoleBinding.mockResolvedValue(undefined);
      mockK8sClient.createDeployment.mockResolvedValue(undefined);
      mockK8sClient.createService.mockResolvedValue(undefined);
      await service.create('test-ns', 'inst-1', { hasUiSteps: true });
    });

    it('still deploys only the test-agent container (chromium is a separate pod)', () => {
      const dep = deployedSpec();
      const containers = dep.spec!.template!.spec!.containers;
      expect(containers).toHaveLength(1);
      expect(containers[0].name).toBe('test-agent');
    });

    it('points BROWSER_URL at the standalone chromium service', () => {
      const env = mainContainer(deployedSpec()).env ?? [];
      const browserURL = env.find((e) => e.name === 'BROWSER_URL');
      expect(browserURL?.value).toBe('http://chromium:9222');
    });
  });

  describe('RBAC resource structure', () => {
    beforeEach(async () => {
      mockK8sClient.createServiceAccount.mockResolvedValue(undefined);
      mockK8sClient.createRole.mockResolvedValue(undefined);
      mockK8sClient.createRoleBinding.mockResolvedValue(undefined);
      mockK8sClient.createDeployment.mockResolvedValue(undefined);
      mockK8sClient.createService.mockResolvedValue(undefined);
      await service.create('test-ns', 'inst-1');
    });

    it('creates service account with correct name and namespace', () => {
      const sa = mockK8sClient.createServiceAccount.mock.calls[0][1];
      expect(sa.metadata).toEqual({
        name: 'test-agent-service-account',
        namespace: 'test-ns',
      });
    });

    it('creates role with configmap, pod, and service read permissions', () => {
      const role = mockK8sClient.createRole.mock.calls[0][1];
      expect(role.metadata).toEqual({
        name: 'test-agent-configmap-reader',
        namespace: 'test-ns',
      });
      expect(role.rules).toHaveLength(3);

      const configmapRule = role.rules[0];
      expect(configmapRule.resources).toEqual(['configmaps']);
      expect(configmapRule.verbs).toEqual(['get', 'list', 'watch']);
      expect(configmapRule.resourceNames).toEqual([
        'dokkimi-interceptor-config',
      ]);

      const podRule = role.rules[1];
      expect(podRule.resources).toEqual(['pods']);
      expect(podRule.verbs).toEqual(['list', 'get']);

      const serviceRule = role.rules[2];
      expect(serviceRule.resources).toEqual(['services']);
      expect(serviceRule.verbs).toEqual(['list']);
    });

    it('creates role binding linking service account to role', () => {
      const rb = mockK8sClient.createRoleBinding.mock.calls[0][1];
      expect(rb.metadata).toEqual({
        name: 'test-agent-configmap-reader-binding',
        namespace: 'test-ns',
      });
      expect(rb.subjects).toEqual([
        {
          kind: 'ServiceAccount',
          name: 'test-agent-service-account',
          namespace: 'test-ns',
        },
      ]);
      expect(rb.roleRef).toEqual({
        kind: 'Role',
        name: 'test-agent-configmap-reader',
        apiGroup: 'rbac.authorization.k8s.io',
      });
    });
  });

  describe('deployment structure', () => {
    beforeEach(async () => {
      mockK8sClient.createServiceAccount.mockResolvedValue(undefined);
      mockK8sClient.createRole.mockResolvedValue(undefined);
      mockK8sClient.createRoleBinding.mockResolvedValue(undefined);
      mockK8sClient.createDeployment.mockResolvedValue(undefined);
      mockK8sClient.createService.mockResolvedValue(undefined);
      await service.create('test-ns', 'inst-1');
    });

    it('sets deployment metadata with correct name, namespace, and labels', () => {
      const dep = deployedSpec();
      expect(dep.metadata).toEqual({
        name: 'test-agent',
        namespace: 'test-ns',
        labels: { app: 'test-agent' },
      });
    });

    it('sets replicas to 1', () => {
      const dep = deployedSpec();
      expect(dep.spec!.replicas).toBe(1);
    });

    it('sets selector matchLabels to app: test-agent', () => {
      const dep = deployedSpec();
      expect(dep.spec!.selector).toEqual({
        matchLabels: { app: 'test-agent' },
      });
    });

    it('sets instance-id label on pod template', () => {
      const dep = deployedSpec();
      expect(dep.spec!.template!.metadata!.labels).toEqual({
        app: 'test-agent',
        'dokkimi.io/instance-id': 'inst-1',
      });
    });

    it('sets terminationGracePeriodSeconds to 1', () => {
      const dep = deployedSpec();
      expect(dep.spec!.template!.spec!.terminationGracePeriodSeconds).toBe(1);
    });

    it('sets serviceAccountName to test-agent-service-account', () => {
      const dep = deployedSpec();
      expect(dep.spec!.template!.spec!.serviceAccountName).toBe(
        'test-agent-service-account',
      );
    });

    it('sets container imagePullPolicy to IfNotPresent', () => {
      const container = mainContainer(deployedSpec());
      expect(container.imagePullPolicy).toBe('IfNotPresent');
    });

    it('sets container resource requests and limits', () => {
      const container = mainContainer(deployedSpec());
      expect(container.resources).toEqual({
        requests: { cpu: '100m', memory: '128Mi' },
        limits: { cpu: '500m', memory: '256Mi' },
      });
    });

    it('sets container port from config', () => {
      const container = mainContainer(deployedSpec());
      expect(container.ports).toEqual([{ containerPort: 80 }]);
    });
  });

  describe('service structure', () => {
    beforeEach(async () => {
      mockK8sClient.createServiceAccount.mockResolvedValue(undefined);
      mockK8sClient.createRole.mockResolvedValue(undefined);
      mockK8sClient.createRoleBinding.mockResolvedValue(undefined);
      mockK8sClient.createDeployment.mockResolvedValue(undefined);
      mockK8sClient.createService.mockResolvedValue(undefined);
      await service.create('test-ns', 'inst-1');
    });

    it('creates service with correct metadata', () => {
      const svc = mockK8sClient.createService.mock.calls[0][1];
      expect(svc.metadata).toEqual({
        name: 'test-agent-service',
        namespace: 'test-ns',
      });
    });

    it('creates service with app: test-agent selector', () => {
      const svc = mockK8sClient.createService.mock.calls[0][1];
      expect(svc.spec.selector).toEqual({ app: 'test-agent' });
    });

    it('creates service with matching port and targetPort', () => {
      const svc = mockK8sClient.createService.mock.calls[0][1];
      expect(svc.spec.ports).toEqual([{ port: 80, targetPort: 80 }]);
    });
  });

  describe('environment variables', () => {
    beforeEach(async () => {
      mockK8sClient.createServiceAccount.mockResolvedValue(undefined);
      mockK8sClient.createRole.mockResolvedValue(undefined);
      mockK8sClient.createRoleBinding.mockResolvedValue(undefined);
      mockK8sClient.createDeployment.mockResolvedValue(undefined);
      mockK8sClient.createService.mockResolvedValue(undefined);
    });

    it('sets K8S_NAMESPACE env var', async () => {
      await service.create('test-ns', 'inst-1');
      const env = mainContainer(deployedSpec()).env ?? [];
      const k8sNs = env.find((e) => e.name === 'K8S_NAMESPACE');
      expect(k8sNs?.value).toBe('test-ns');
    });

    it('sets CONFIG_MAP_NAME to dokkimi-interceptor-config', async () => {
      await service.create('test-ns', 'inst-1');
      const env = mainContainer(deployedSpec()).env ?? [];
      const cmName = env.find((e) => e.name === 'CONFIG_MAP_NAME');
      expect(cmName?.value).toBe('dokkimi-interceptor-config');
    });

    it('sets DEFAULT_VIEWPORT_WIDTH and DEFAULT_VIEWPORT_HEIGHT from config', async () => {
      await service.create('test-ns', 'inst-1', { hasUiSteps: true });
      const env = mainContainer(deployedSpec()).env ?? [];
      const width = env.find((e) => e.name === 'DEFAULT_VIEWPORT_WIDTH');
      const height = env.find((e) => e.name === 'DEFAULT_VIEWPORT_HEIGHT');
      expect(width?.value).toBe('1280');
      expect(height?.value).toBe('720');
    });

    it('includes INTERCEPTOR_URL pointing at interceptor service', async () => {
      await service.create('test-ns', 'inst-1');
      const env = mainContainer(deployedSpec()).env ?? [];
      const interceptorUrl = env.find((e) => e.name === 'INTERCEPTOR_URL');
      expect(interceptorUrl?.value).toContain('interceptor-service.test-ns');
    });
  });

  describe('RBAC namespace passed correctly', () => {
    beforeEach(async () => {
      mockK8sClient.createServiceAccount.mockResolvedValue(undefined);
      mockK8sClient.createRole.mockResolvedValue(undefined);
      mockK8sClient.createRoleBinding.mockResolvedValue(undefined);
      mockK8sClient.createDeployment.mockResolvedValue(undefined);
      mockK8sClient.createService.mockResolvedValue(undefined);
    });

    it('passes namespace as first arg to all k8s resource calls', async () => {
      await service.create('custom-ns', 'inst-2');

      expect(mockK8sClient.createServiceAccount).toHaveBeenCalledWith(
        'custom-ns',
        expect.any(Object),
      );
      expect(mockK8sClient.createRole).toHaveBeenCalledWith(
        'custom-ns',
        expect.any(Object),
      );
      expect(mockK8sClient.createRoleBinding).toHaveBeenCalledWith(
        'custom-ns',
        expect.any(Object),
      );
      expect(mockK8sClient.createDeployment).toHaveBeenCalledWith(
        'custom-ns',
        expect.any(Object),
      );
      expect(mockK8sClient.createService).toHaveBeenCalledWith(
        'custom-ns',
        expect.any(Object),
      );
    });
  });
});
