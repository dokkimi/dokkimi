// Mock @kubernetes/client-node BEFORE any imports
import * as k8s from '@kubernetes/client-node';

const mockCoreApi = {
  createNamespacedService: jest.fn(),
  createNamespacedServiceAccount: jest.fn(),
  createNamespacedConfigMap: jest.fn(),
  replaceNamespacedConfigMap: jest.fn(),
  deleteNamespacedConfigMap: jest.fn(),
  readNamespacedService: jest.fn(),
};

const mockAppsApi = {
  createNamespacedDeployment: jest.fn(),
};

const mockNetworkingApi = {
  createNamespacedIngress: jest.fn(),
  replaceNamespacedIngress: jest.fn(),
  deleteNamespacedIngress: jest.fn(),
};

const mockRbacApi = {
  createNamespacedRole: jest.fn(),
  createNamespacedRoleBinding: jest.fn(),
};

const mockK8sClient = {
  core: mockCoreApi,
  apps: mockAppsApi,
  networking: mockNetworkingApi,
  rbac: mockRbacApi,
};

import { Test, TestingModule } from '@nestjs/testing';
import { KubernetesResourceService } from './kubernetes-resource.service';
import { KubernetesClientService } from './kubernetes-client.service';

describe('KubernetesResourceService', () => {
  let service: KubernetesResourceService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KubernetesResourceService,
        {
          provide: KubernetesClientService,
          useValue: mockK8sClient,
        },
      ],
    }).compile();

    service = module.get<KubernetesResourceService>(KubernetesResourceService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createDeployment', () => {
    it('should create a deployment', async () => {
      const deployment = {
        metadata: {
          name: 'test-deployment',
          namespace: 'test-namespace',
        },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: 'test' } },
          template: {
            metadata: { labels: { app: 'test' } },
            spec: { containers: [] },
          },
        },
      };

      mockAppsApi.createNamespacedDeployment.mockResolvedValue(undefined);

      await service.createDeployment(
        'test-namespace',
        deployment as k8s.V1Deployment,
      );

      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledWith({
        namespace: 'test-namespace',
        body: deployment,
      });
    });

    it('should handle deployment already exists (409 conflict)', async () => {
      const deployment = {
        metadata: { name: 'test-deployment' },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: 'test' } },
          template: {
            metadata: { labels: { app: 'test' } },
            spec: { containers: [] },
          },
        },
      };

      const conflictError = { body: { code: 409 }, statusCode: 409 };
      mockAppsApi.createNamespacedDeployment.mockRejectedValue(conflictError);

      await expect(
        service.createDeployment(
          'test-namespace',
          deployment as k8s.V1Deployment,
        ),
      ).resolves.not.toThrow();
    });

    it('should throw for non-409 errors', async () => {
      const deployment = {
        metadata: { name: 'test-deployment' },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: 'test' } },
          template: {
            metadata: { labels: { app: 'test' } },
            spec: { containers: [] },
          },
        },
      };

      mockAppsApi.createNamespacedDeployment.mockRejectedValue(
        new Error('Permission denied'),
      );

      await expect(
        service.createDeployment(
          'test-namespace',
          deployment as k8s.V1Deployment,
        ),
      ).rejects.toThrow('Permission denied');
    });
  });

  describe('createService', () => {
    it('should create a service', async () => {
      const k8sService = {
        metadata: { name: 'test-service', namespace: 'test-namespace' },
        spec: { selector: { app: 'test' }, ports: [] },
      };

      mockCoreApi.createNamespacedService.mockResolvedValue(undefined);

      await service.createService(
        'test-namespace',
        k8sService as k8s.V1Service,
      );

      expect(mockCoreApi.createNamespacedService).toHaveBeenCalledWith({
        namespace: 'test-namespace',
        body: k8sService,
      });
    });

    it('should handle service already exists (409 conflict)', async () => {
      const k8sService = {
        metadata: { name: 'test-service', namespace: 'test-namespace' },
        spec: { selector: { app: 'test' }, ports: [] },
      };

      const conflictError = { body: { code: 409 }, statusCode: 409 };
      mockCoreApi.createNamespacedService.mockRejectedValue(conflictError);

      await expect(
        service.createService('test-namespace', k8sService as k8s.V1Service),
      ).resolves.not.toThrow();
    });

    it('should throw for non-409 errors', async () => {
      const k8sService = {
        metadata: { name: 'test-service', namespace: 'test-namespace' },
        spec: { selector: { app: 'test' }, ports: [] },
      };

      mockCoreApi.createNamespacedService.mockRejectedValue(
        new Error('Permission denied'),
      );

      await expect(
        service.createService('test-namespace', k8sService as k8s.V1Service),
      ).rejects.toThrow('Permission denied');
    });
  });

  describe('createConfigMap', () => {
    it('should create a ConfigMap', async () => {
      const configMap = {
        metadata: { name: 'test-configmap', namespace: 'test-namespace' },
        data: { key1: 'value1' },
      };

      mockCoreApi.createNamespacedConfigMap.mockResolvedValue(undefined);

      await service.createConfigMap(
        'test-namespace',
        configMap as k8s.V1ConfigMap,
      );

      expect(mockCoreApi.createNamespacedConfigMap).toHaveBeenCalledWith({
        namespace: 'test-namespace',
        body: configMap,
      });
    });

    it('should update ConfigMap if it already exists (409 conflict)', async () => {
      const configMap = {
        metadata: { name: 'test-configmap', namespace: 'test-namespace' },
        data: { key1: 'value1' },
      };

      const conflictError = { body: { code: 409 }, statusCode: 409 };
      mockCoreApi.createNamespacedConfigMap.mockRejectedValueOnce(
        conflictError,
      );
      mockCoreApi.replaceNamespacedConfigMap.mockResolvedValue(undefined);

      await service.createConfigMap(
        'test-namespace',
        configMap as k8s.V1ConfigMap,
      );

      expect(mockCoreApi.createNamespacedConfigMap).toHaveBeenCalledTimes(1);
      expect(mockCoreApi.replaceNamespacedConfigMap).toHaveBeenCalledWith({
        name: 'test-configmap',
        namespace: 'test-namespace',
        body: configMap,
      });
    });

    it('should throw for non-409 errors', async () => {
      const configMap = {
        metadata: { name: 'test-configmap', namespace: 'test-namespace' },
        data: { key1: 'value1' },
      };

      mockCoreApi.createNamespacedConfigMap.mockRejectedValue(
        new Error('Internal error'),
      );

      await expect(
        service.createConfigMap('test-namespace', configMap as k8s.V1ConfigMap),
      ).rejects.toThrow('Internal error');
    });
  });

  describe('updateConfigMap', () => {
    it('should update a ConfigMap using replaceNamespacedConfigMap', async () => {
      const configMap = {
        metadata: { name: 'test-configmap', namespace: 'test-namespace' },
        data: { key1: 'value1' },
      };

      mockCoreApi.replaceNamespacedConfigMap.mockResolvedValue(undefined);

      await service.updateConfigMap(
        'test-namespace',
        configMap as k8s.V1ConfigMap,
      );

      expect(mockCoreApi.replaceNamespacedConfigMap).toHaveBeenCalledWith({
        name: 'test-configmap',
        namespace: 'test-namespace',
        body: configMap,
      });
      expect(mockCoreApi.createNamespacedConfigMap).not.toHaveBeenCalled();
    });

    it('should create ConfigMap if it does not exist (404 error)', async () => {
      const configMap = {
        metadata: { name: 'test-configmap', namespace: 'test-namespace' },
        data: { key1: 'value1' },
      };

      const notFoundError = { body: { code: 404 } };
      mockCoreApi.replaceNamespacedConfigMap.mockRejectedValue(notFoundError);
      mockCoreApi.createNamespacedConfigMap.mockResolvedValue(undefined);

      await service.updateConfigMap(
        'test-namespace',
        configMap as k8s.V1ConfigMap,
      );

      expect(mockCoreApi.replaceNamespacedConfigMap).toHaveBeenCalledWith({
        name: 'test-configmap',
        namespace: 'test-namespace',
        body: configMap,
      });
      expect(mockCoreApi.createNamespacedConfigMap).toHaveBeenCalledWith({
        namespace: 'test-namespace',
        body: configMap,
      });
    });

    it('should throw if ConfigMap name is missing', async () => {
      const configMap = {
        metadata: {},
        data: { key1: 'value1' },
      };

      await expect(
        service.updateConfigMap('test-namespace', configMap as k8s.V1ConfigMap),
      ).rejects.toThrow('ConfigMap name is required');
    });

    it('should throw for non-404 errors', async () => {
      const configMap = {
        metadata: { name: 'test-configmap' },
        data: { key1: 'value1' },
      };

      mockCoreApi.replaceNamespacedConfigMap.mockRejectedValue(
        new Error('Internal error'),
      );

      await expect(
        service.updateConfigMap('test-namespace', configMap as k8s.V1ConfigMap),
      ).rejects.toThrow('Internal error');
    });
  });

  describe('createOrUpdateConfigMap', () => {
    it('should update ConfigMap when it already exists (replace succeeds)', async () => {
      const configMap = {
        metadata: { name: 'test-configmap' },
        data: { key1: 'value1' },
      };

      mockCoreApi.replaceNamespacedConfigMap.mockResolvedValue(undefined);

      await service.createOrUpdateConfigMap(
        'test-namespace',
        configMap as k8s.V1ConfigMap,
      );

      expect(mockCoreApi.replaceNamespacedConfigMap).toHaveBeenCalledWith({
        name: 'test-configmap',
        namespace: 'test-namespace',
        body: configMap,
      });
      expect(mockCoreApi.createNamespacedConfigMap).not.toHaveBeenCalled();
    });

    it('should create ConfigMap when replace returns 404', async () => {
      const configMap = {
        metadata: { name: 'test-configmap' },
        data: { key1: 'value1' },
      };

      const notFoundError = { body: { code: 404 } };
      mockCoreApi.replaceNamespacedConfigMap.mockRejectedValueOnce(
        notFoundError,
      );
      mockCoreApi.createNamespacedConfigMap.mockResolvedValue(undefined);

      await service.createOrUpdateConfigMap(
        'test-namespace',
        configMap as k8s.V1ConfigMap,
      );

      expect(mockCoreApi.replaceNamespacedConfigMap).toHaveBeenCalledTimes(1);
      expect(mockCoreApi.createNamespacedConfigMap).toHaveBeenCalledWith({
        namespace: 'test-namespace',
        body: configMap,
      });
    });

    it('should handle race condition: replace 404, then create 409, then replace again', async () => {
      const configMap = {
        metadata: { name: 'test-configmap' },
        data: { key1: 'value1' },
      };

      const notFoundError = { body: { code: 404 } };
      const conflictError = { body: { code: 409 }, statusCode: 409 };
      mockCoreApi.replaceNamespacedConfigMap
        .mockRejectedValueOnce(notFoundError)
        .mockResolvedValueOnce(undefined);
      mockCoreApi.createNamespacedConfigMap.mockRejectedValueOnce(
        conflictError,
      );

      await service.createOrUpdateConfigMap(
        'test-namespace',
        configMap as k8s.V1ConfigMap,
      );

      expect(mockCoreApi.replaceNamespacedConfigMap).toHaveBeenCalledTimes(2);
      expect(mockCoreApi.createNamespacedConfigMap).toHaveBeenCalledTimes(1);
    });

    it('should throw if ConfigMap name is missing', async () => {
      const configMap = {
        metadata: {},
        data: { key1: 'value1' },
      };

      await expect(
        service.createOrUpdateConfigMap(
          'test-namespace',
          configMap as k8s.V1ConfigMap,
        ),
      ).rejects.toThrow('ConfigMap name is required');
    });

    it('should throw for non-404 errors on replace', async () => {
      const configMap = {
        metadata: { name: 'test-configmap' },
        data: { key1: 'value1' },
      };

      mockCoreApi.replaceNamespacedConfigMap.mockRejectedValue(
        new Error('Internal error'),
      );

      await expect(
        service.createOrUpdateConfigMap(
          'test-namespace',
          configMap as k8s.V1ConfigMap,
        ),
      ).rejects.toThrow('Internal error');
    });

    it('should throw for non-409 errors on create after 404', async () => {
      const configMap = {
        metadata: { name: 'test-configmap' },
        data: { key1: 'value1' },
      };

      const notFoundError = { body: { code: 404 } };
      const createError = { statusCode: 403, message: 'Forbidden' };
      mockCoreApi.replaceNamespacedConfigMap.mockRejectedValueOnce(
        notFoundError,
      );
      mockCoreApi.createNamespacedConfigMap.mockRejectedValueOnce(createError);

      await expect(
        service.createOrUpdateConfigMap(
          'test-namespace',
          configMap as k8s.V1ConfigMap,
        ),
      ).rejects.toEqual(createError);
    });
  });

  describe('deleteConfigMap', () => {
    it('should delete a ConfigMap', async () => {
      mockCoreApi.deleteNamespacedConfigMap.mockResolvedValue(undefined);

      await service.deleteConfigMap('test-namespace', 'test-configmap');

      expect(mockCoreApi.deleteNamespacedConfigMap).toHaveBeenCalledWith({
        name: 'test-configmap',
        namespace: 'test-namespace',
      });
    });

    it('should handle 404 error gracefully (ConfigMap not found)', async () => {
      const notFoundError = { body: { code: 404 } };
      mockCoreApi.deleteNamespacedConfigMap.mockRejectedValue(notFoundError);

      await expect(
        service.deleteConfigMap('test-namespace', 'test-configmap'),
      ).resolves.not.toThrow();
    });

    it('should throw for non-404 errors', async () => {
      mockCoreApi.deleteNamespacedConfigMap.mockRejectedValue(
        new Error('Other error'),
      );

      await expect(
        service.deleteConfigMap('test-namespace', 'test-configmap'),
      ).rejects.toThrow('Other error');
    });
  });

  describe('createIngress', () => {
    it('should create an ingress successfully', async () => {
      const ingress: k8s.V1Ingress = {
        metadata: { name: 'test-ingress', namespace: 'test-namespace' },
        spec: {
          rules: [
            {
              http: {
                paths: [
                  {
                    path: '/test',
                    pathType: 'Prefix',
                    backend: {
                      service: {
                        name: 'test-service',
                        port: { number: 80 },
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      };

      mockNetworkingApi.createNamespacedIngress.mockResolvedValue(undefined);

      await service.createIngress('test-namespace', ingress);

      expect(mockNetworkingApi.createNamespacedIngress).toHaveBeenCalledWith({
        namespace: 'test-namespace',
        body: ingress,
      });
    });

    it('should handle ingress already exists (409)', async () => {
      const ingress: k8s.V1Ingress = {
        metadata: { name: 'test-ingress' },
        spec: {},
      };
      const error = { body: { code: 409 }, statusCode: 409 };
      mockNetworkingApi.createNamespacedIngress.mockRejectedValue(error);
      mockNetworkingApi.replaceNamespacedIngress.mockResolvedValue(undefined);

      await service.createIngress('test-namespace', ingress);

      expect(mockNetworkingApi.createNamespacedIngress).toHaveBeenCalled();
      expect(mockNetworkingApi.replaceNamespacedIngress).toHaveBeenCalled();
    });

    it('should throw error for other errors', async () => {
      const ingress: k8s.V1Ingress = {
        metadata: { name: 'test-ingress' },
        spec: {},
      };
      const error = new Error('Permission denied');
      mockNetworkingApi.createNamespacedIngress.mockRejectedValue(error);

      await expect(
        service.createIngress('test-namespace', ingress),
      ).rejects.toThrow('Permission denied');
    });
  });

  describe('updateIngress', () => {
    it('should update an ingress successfully', async () => {
      const ingress: k8s.V1Ingress = {
        metadata: { name: 'test-ingress', namespace: 'test-namespace' },
        spec: {
          rules: [
            {
              http: {
                paths: [
                  {
                    path: '/test',
                    pathType: 'Prefix',
                    backend: {
                      service: {
                        name: 'test-service',
                        port: { number: 80 },
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      };

      mockNetworkingApi.replaceNamespacedIngress.mockResolvedValue(undefined);

      await service.updateIngress('test-namespace', ingress);

      expect(mockNetworkingApi.replaceNamespacedIngress).toHaveBeenCalledWith({
        name: 'test-ingress',
        namespace: 'test-namespace',
        body: ingress,
      });
    });

    it('should throw error if ingress name is missing', async () => {
      const ingress: k8s.V1Ingress = {
        metadata: {},
        spec: {},
      };

      await expect(
        service.updateIngress('test-namespace', ingress),
      ).rejects.toThrow('Ingress name is required');
    });
  });

  describe('deleteIngress', () => {
    it('should delete an ingress successfully', async () => {
      mockNetworkingApi.deleteNamespacedIngress.mockResolvedValue(undefined);

      await service.deleteIngress('test-namespace', 'test-ingress');

      expect(mockNetworkingApi.deleteNamespacedIngress).toHaveBeenCalledWith({
        name: 'test-ingress',
        namespace: 'test-namespace',
      });
    });

    it('should handle ingress not found (404)', async () => {
      const notFoundError = { body: { code: 404 } };
      mockNetworkingApi.deleteNamespacedIngress.mockRejectedValue(
        notFoundError,
      );

      await expect(
        service.deleteIngress('test-namespace', 'test-ingress'),
      ).resolves.not.toThrow();
    });

    it('should throw for non-404 errors', async () => {
      mockNetworkingApi.deleteNamespacedIngress.mockRejectedValue(
        new Error('Other error'),
      );

      await expect(
        service.deleteIngress('test-namespace', 'test-ingress'),
      ).rejects.toThrow('Other error');
    });
  });

  describe('createServiceAccount', () => {
    it('should create a service account successfully', async () => {
      const serviceAccount: k8s.V1ServiceAccount = {
        metadata: { name: 'test-sa', namespace: 'test-namespace' },
      };

      mockCoreApi.createNamespacedServiceAccount.mockResolvedValue(undefined);

      await service.createServiceAccount('test-namespace', serviceAccount);

      expect(mockCoreApi.createNamespacedServiceAccount).toHaveBeenCalledWith({
        namespace: 'test-namespace',
        body: serviceAccount,
      });
    });

    it('should handle service account already exists (409)', async () => {
      const serviceAccount: k8s.V1ServiceAccount = {
        metadata: { name: 'test-sa', namespace: 'test-namespace' },
      };

      const conflictError = { body: { code: 409 }, statusCode: 409 };
      mockCoreApi.createNamespacedServiceAccount.mockRejectedValue(
        conflictError,
      );

      await expect(
        service.createServiceAccount('test-namespace', serviceAccount),
      ).resolves.not.toThrow();
    });

    it('should retry on transient failures', async () => {
      const serviceAccount: k8s.V1ServiceAccount = {
        metadata: { name: 'test-sa', namespace: 'test-namespace' },
      };

      mockCoreApi.createNamespacedServiceAccount
        .mockRejectedValueOnce({ statusCode: 500 })
        .mockResolvedValueOnce(undefined);

      await service.createServiceAccount('test-namespace', serviceAccount);

      expect(mockCoreApi.createNamespacedServiceAccount).toHaveBeenCalledTimes(
        2,
      );
    });
  });

  describe('createRole', () => {
    it('should create a role successfully', async () => {
      const role: k8s.V1Role = {
        metadata: { name: 'test-role', namespace: 'test-namespace' },
        rules: [
          {
            apiGroups: [''],
            resources: ['configmaps'],
            verbs: ['get', 'list', 'watch'],
          },
        ],
      };

      mockRbacApi.createNamespacedRole.mockResolvedValue(undefined);

      await service.createRole('test-namespace', role);

      expect(mockRbacApi.createNamespacedRole).toHaveBeenCalledWith({
        namespace: 'test-namespace',
        body: role,
      });
    });

    it('should handle role already exists (409)', async () => {
      const role: k8s.V1Role = {
        metadata: { name: 'test-role', namespace: 'test-namespace' },
        rules: [],
      };

      const conflictError = { body: { code: 409 }, statusCode: 409 };
      mockRbacApi.createNamespacedRole.mockRejectedValue(conflictError);

      await expect(
        service.createRole('test-namespace', role),
      ).resolves.not.toThrow();
    });

    it('should retry on transient failures', async () => {
      const role: k8s.V1Role = {
        metadata: { name: 'test-role', namespace: 'test-namespace' },
        rules: [],
      };

      mockRbacApi.createNamespacedRole
        .mockRejectedValueOnce({ statusCode: 500 })
        .mockResolvedValueOnce(undefined);

      await service.createRole('test-namespace', role);

      expect(mockRbacApi.createNamespacedRole).toHaveBeenCalledTimes(2);
    });
  });

  describe('createRoleBinding', () => {
    it('should create a role binding successfully', async () => {
      const roleBinding: k8s.V1RoleBinding = {
        metadata: { name: 'test-rolebinding', namespace: 'test-namespace' },
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'Role',
          name: 'test-role',
        },
        subjects: [
          {
            kind: 'ServiceAccount',
            name: 'test-sa',
            namespace: 'test-namespace',
          },
        ],
      };

      mockRbacApi.createNamespacedRoleBinding.mockResolvedValue(undefined);

      await service.createRoleBinding('test-namespace', roleBinding);

      expect(mockRbacApi.createNamespacedRoleBinding).toHaveBeenCalledWith({
        namespace: 'test-namespace',
        body: roleBinding,
      });
    });

    it('should handle role binding already exists (409)', async () => {
      const roleBinding: k8s.V1RoleBinding = {
        metadata: { name: 'test-rolebinding', namespace: 'test-namespace' },
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'Role',
          name: 'test-role',
        },
        subjects: [],
      };

      const conflictError = { body: { code: 409 }, statusCode: 409 };
      mockRbacApi.createNamespacedRoleBinding.mockRejectedValue(conflictError);

      await expect(
        service.createRoleBinding('test-namespace', roleBinding),
      ).resolves.not.toThrow();
    });

    it('should retry on transient failures', async () => {
      const roleBinding: k8s.V1RoleBinding = {
        metadata: { name: 'test-rolebinding', namespace: 'test-namespace' },
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'Role',
          name: 'test-role',
        },
        subjects: [],
      };

      mockRbacApi.createNamespacedRoleBinding
        .mockRejectedValueOnce({ statusCode: 500 })
        .mockResolvedValueOnce(undefined);

      await service.createRoleBinding('test-namespace', roleBinding);

      expect(mockRbacApi.createNamespacedRoleBinding).toHaveBeenCalledTimes(2);
    });
  });

  describe('getService', () => {
    it('should return a service by name', async () => {
      const mockService = {
        metadata: { name: 'test-service' },
        spec: { clusterIP: '10.0.0.1' },
      };
      mockCoreApi.readNamespacedService.mockResolvedValue({
        body: mockService,
      });

      const result = await service.getService('test-namespace', 'test-service');

      expect(result).toEqual(mockService);
    });

    it('should return a service directly when no body wrapper', async () => {
      const mockService = {
        metadata: { name: 'test-service' },
        spec: { clusterIP: '10.0.0.1' },
      };
      mockCoreApi.readNamespacedService.mockResolvedValue(mockService);

      const result = await service.getService('test-namespace', 'test-service');

      expect(result).toEqual(mockService);
    });

    it('should throw if response has no metadata', async () => {
      mockCoreApi.readNamespacedService.mockResolvedValue({
        body: { spec: { clusterIP: '10.0.0.1' } },
      });

      await expect(
        service.getService('test-namespace', 'test-service'),
      ).rejects.toThrow(
        'Invalid response from Kubernetes API for service test-service',
      );
    });

    it('should throw if response body has no metadata (body wrapper with empty object)', async () => {
      mockCoreApi.readNamespacedService.mockResolvedValue({
        body: {},
      });

      await expect(
        service.getService('test-namespace', 'test-service'),
      ).rejects.toThrow(
        'Invalid response from Kubernetes API for service test-service',
      );
    });

    it('should throw if service not found (404)', async () => {
      mockCoreApi.readNamespacedService.mockRejectedValue({
        body: { code: 404 },
      });

      await expect(
        service.getService('test-namespace', 'test-service'),
      ).rejects.toThrow(
        'Service test-service not found in namespace test-namespace',
      );
    });

    it('should rethrow non-404 errors', async () => {
      mockCoreApi.readNamespacedService.mockRejectedValue(
        new Error('Network error'),
      );

      await expect(
        service.getService('test-namespace', 'test-service'),
      ).rejects.toThrow('Network error');
    });
  });

  describe('createServiceAccount - error paths', () => {
    it('should log error and throw for non-409 errors', async () => {
      const serviceAccount: k8s.V1ServiceAccount = {
        metadata: { name: 'test-sa', namespace: 'test-namespace' },
      };

      mockCoreApi.createNamespacedServiceAccount.mockRejectedValue(
        new Error('Permission denied'),
      );

      await expect(
        service.createServiceAccount('test-namespace', serviceAccount),
      ).rejects.toThrow('Permission denied');
    });
  });

  describe('createRole - error paths', () => {
    it('should log error and throw for non-409 errors', async () => {
      const role: k8s.V1Role = {
        metadata: { name: 'test-role', namespace: 'test-namespace' },
        rules: [],
      };

      mockRbacApi.createNamespacedRole.mockRejectedValue(
        new Error('Permission denied'),
      );

      await expect(service.createRole('test-namespace', role)).rejects.toThrow(
        'Permission denied',
      );
    });
  });

  describe('createRoleBinding - error paths', () => {
    it('should log error and throw for non-409 errors', async () => {
      const roleBinding: k8s.V1RoleBinding = {
        metadata: { name: 'test-rolebinding', namespace: 'test-namespace' },
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'Role',
          name: 'test-role',
        },
        subjects: [],
      };

      mockRbacApi.createNamespacedRoleBinding.mockRejectedValue(
        new Error('Permission denied'),
      );

      await expect(
        service.createRoleBinding('test-namespace', roleBinding),
      ).rejects.toThrow('Permission denied');
    });
  });
});
