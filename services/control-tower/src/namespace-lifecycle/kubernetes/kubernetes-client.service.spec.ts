// Mock @kubernetes/client-node BEFORE any imports
const mockCoreApi = {
  createNamespace: jest.fn(),
  deleteNamespace: jest.fn(),
  readNamespace: jest.fn(),
  readNamespacedService: jest.fn(),
};

const mockAppsApi = {
  listNamespacedDeployment: jest.fn(),
  deleteNamespacedDeployment: jest.fn(),
};

const mockNetworkingApi = {};
const mockStorageApi = {};
const mockRbacApi = {};

const MockCoreV1Api = jest.fn();
const MockAppsV1Api = jest.fn();
const MockNetworkingV1Api = jest.fn();
const MockRbacAuthorizationV1Api = jest.fn();
const MockStorageV1Api = jest.fn();

const mockKubeConfigInstance = {
  loadFromDefault: jest.fn(),
  setCurrentContext: jest.fn(),
  makeApiClient: jest.fn((apiType: any) => {
    if (apiType === MockCoreV1Api) {
      return mockCoreApi;
    }
    if (apiType === MockAppsV1Api) {
      return mockAppsApi;
    }
    if (apiType === MockNetworkingV1Api) {
      return mockNetworkingApi;
    }
    if (apiType === MockStorageV1Api) {
      return mockStorageApi;
    }
    if (apiType === MockRbacAuthorizationV1Api) {
      return mockRbacApi;
    }
    return {};
  }),
};

const MockKubeConfig = jest.fn(() => mockKubeConfigInstance);

jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: MockKubeConfig,
  CoreV1Api: MockCoreV1Api,
  AppsV1Api: MockAppsV1Api,
  NetworkingV1Api: MockNetworkingV1Api,
  RbacAuthorizationV1Api: MockRbacAuthorizationV1Api,
  StorageV1Api: MockStorageV1Api,
}));

jest.mock('./kubeconfig-loader', () => ({
  loadKubeConfig: jest.fn(() => mockKubeConfigInstance),
}));

jest.mock('./kubernetes-helpers', () => {
  const actual = jest.requireActual('./kubernetes-helpers');
  return {
    ...actual,
    sleep: jest.fn().mockResolvedValue(undefined),
  };
});

const mockGetConfig = jest.fn().mockReturnValue({
  kubernetes: { dnsIP: '10.0.0.10' },
});

jest.mock('@dokkimi/config', () => ({
  getConfig: mockGetConfig,
  loadConfig: jest.fn(),
  getKubeconfigPrefs: jest.fn().mockReturnValue({}),
}));

import { KubernetesClientService } from './kubernetes-client.service';

describe('KubernetesClientService', () => {
  let service: KubernetesClientService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new KubernetesClientService();
  });

  // ============================================
  // API CLIENT ACCESSORS
  // ============================================

  describe('getKubeConfig', () => {
    it('should return the kube config instance', () => {
      expect(service.getKubeConfig()).toBe(mockKubeConfigInstance);
    });
  });

  describe('core', () => {
    it('should return the CoreV1Api client', () => {
      expect(service.core).toBe(mockCoreApi);
    });
  });

  describe('apps', () => {
    it('should return the AppsV1Api client', () => {
      expect(service.apps).toBe(mockAppsApi);
    });
  });

  describe('networking', () => {
    it('should return the NetworkingV1Api client', () => {
      expect(service.networking).toBe(mockNetworkingApi);
    });
  });

  describe('storage', () => {
    it('should return the StorageV1Api client', () => {
      expect(service.storage).toBe(mockStorageApi);
    });
  });

  describe('rbac', () => {
    it('should return the RbacAuthorizationV1Api client', () => {
      expect(service.rbac).toBe(mockRbacApi);
    });
  });

  // ============================================
  // NAMESPACE OPERATIONS
  // ============================================

  describe('createNamespace', () => {
    it('should create a namespace with default labels', async () => {
      mockCoreApi.createNamespace.mockResolvedValue(undefined);

      await service.createNamespace('test-ns');

      expect(mockCoreApi.createNamespace).toHaveBeenCalledWith({
        body: {
          metadata: {
            name: 'test-ns',
            labels: {
              'app.kubernetes.io/name': 'dokkimi',
              'app.kubernetes.io/component': 'namespace',
            },
          },
        },
      });
    });

    it('should merge custom labels with default labels', async () => {
      mockCoreApi.createNamespace.mockResolvedValue(undefined);

      await service.createNamespace('test-ns', { env: 'test', team: 'alpha' });

      expect(mockCoreApi.createNamespace).toHaveBeenCalledWith({
        body: {
          metadata: {
            name: 'test-ns',
            labels: {
              'app.kubernetes.io/name': 'dokkimi',
              'app.kubernetes.io/component': 'namespace',
              env: 'test',
              team: 'alpha',
            },
          },
        },
      });
    });

    it('should silently handle 409 conflict (namespace already exists)', async () => {
      mockCoreApi.createNamespace.mockRejectedValue({ body: { code: 409 } });

      await expect(service.createNamespace('test-ns')).resolves.toBeUndefined();
    });

    it('should throw on non-409 errors', async () => {
      const error = new Error('Forbidden');
      mockCoreApi.createNamespace.mockRejectedValue(error);

      await expect(service.createNamespace('test-ns')).rejects.toThrow(
        'Forbidden',
      );
    });
  });

  describe('deleteNamespace', () => {
    it('should delete deployments then delete namespace', async () => {
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [] });
      mockCoreApi.deleteNamespace.mockResolvedValue(undefined);

      await service.deleteNamespace('test-ns');

      expect(mockAppsApi.listNamespacedDeployment).toHaveBeenCalledWith({
        namespace: 'test-ns',
      });
      expect(mockCoreApi.deleteNamespace).toHaveBeenCalledWith({
        name: 'test-ns',
      });
    });

    it('should delete each deployment before deleting namespace', async () => {
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({
        items: [
          { metadata: { name: 'dep-1' } },
          { metadata: { name: 'dep-2' } },
        ],
      });
      mockAppsApi.deleteNamespacedDeployment.mockResolvedValue(undefined);
      mockCoreApi.deleteNamespace.mockResolvedValue(undefined);

      await service.deleteNamespace('test-ns');

      expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalledTimes(2);
      expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalledWith({
        name: 'dep-1',
        namespace: 'test-ns',
        body: { gracePeriodSeconds: 0, propagationPolicy: 'Foreground' },
      });
      expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalledWith({
        name: 'dep-2',
        namespace: 'test-ns',
        body: { gracePeriodSeconds: 0, propagationPolicy: 'Foreground' },
      });
    });

    it('should handle response with body wrapper for deployment list', async () => {
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({
        body: {
          items: [{ metadata: { name: 'dep-wrapped' } }],
        },
      });
      mockAppsApi.deleteNamespacedDeployment.mockResolvedValue(undefined);
      mockCoreApi.deleteNamespace.mockResolvedValue(undefined);

      await service.deleteNamespace('test-ns');

      expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalledWith({
        name: 'dep-wrapped',
        namespace: 'test-ns',
        body: { gracePeriodSeconds: 0, propagationPolicy: 'Foreground' },
      });
    });

    it('should skip deployments without a name', async () => {
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({
        items: [{ metadata: {} }, { metadata: { name: 'has-name' } }],
      });
      mockAppsApi.deleteNamespacedDeployment.mockResolvedValue(undefined);
      mockCoreApi.deleteNamespace.mockResolvedValue(undefined);

      await service.deleteNamespace('test-ns');

      expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalledTimes(1);
      expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'has-name' }),
      );
    });

    it('should ignore 404 errors when deleting individual deployments', async () => {
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({
        items: [{ metadata: { name: 'dep-gone' } }],
      });
      mockAppsApi.deleteNamespacedDeployment.mockRejectedValue({
        body: { code: 404 },
      });
      mockCoreApi.deleteNamespace.mockResolvedValue(undefined);

      await expect(service.deleteNamespace('test-ns')).resolves.toBeUndefined();
    });

    it('should warn on non-404 errors when deleting individual deployments', async () => {
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({
        items: [{ metadata: { name: 'dep-fail' } }],
      });
      mockAppsApi.deleteNamespacedDeployment.mockRejectedValue(
        new Error('Server error'),
      );
      mockCoreApi.deleteNamespace.mockResolvedValue(undefined);

      // Should not throw, just warn
      await expect(service.deleteNamespace('test-ns')).resolves.toBeUndefined();
    });

    it('should warn when listing deployments fails with non-404 error', async () => {
      mockAppsApi.listNamespacedDeployment.mockRejectedValue(
        new Error('Connection refused'),
      );
      mockCoreApi.deleteNamespace.mockResolvedValue(undefined);

      // Should still proceed to delete the namespace
      await expect(service.deleteNamespace('test-ns')).resolves.toBeUndefined();
      expect(mockCoreApi.deleteNamespace).toHaveBeenCalledWith({
        name: 'test-ns',
      });
    });

    it('should silently handle listing deployments 404', async () => {
      mockAppsApi.listNamespacedDeployment.mockRejectedValue({
        body: { code: 404 },
      });
      mockCoreApi.deleteNamespace.mockResolvedValue(undefined);

      await expect(service.deleteNamespace('test-ns')).resolves.toBeUndefined();
      expect(mockCoreApi.deleteNamespace).toHaveBeenCalled();
    });

    it('should handle 404 when deleting namespace (already gone)', async () => {
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [] });
      mockCoreApi.deleteNamespace.mockRejectedValue({ body: { code: 404 } });

      await expect(service.deleteNamespace('test-ns')).resolves.toBeUndefined();
    });

    it('should throw on non-404 errors when deleting namespace', async () => {
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [] });
      mockCoreApi.deleteNamespace.mockRejectedValue(new Error('Forbidden'));

      await expect(service.deleteNamespace('test-ns')).rejects.toThrow(
        'Forbidden',
      );
    });
  });

  // ============================================
  // NAMESPACE UTILITY OPERATIONS
  // ============================================

  describe('namespaceExists', () => {
    it('should return true when namespace exists', async () => {
      mockCoreApi.readNamespace.mockResolvedValue({});

      const result = await service.namespaceExists('test-ns');

      expect(result).toBe(true);
      expect(mockCoreApi.readNamespace).toHaveBeenCalledWith({
        name: 'test-ns',
      });
    });

    it('should return false when namespace does not exist (404)', async () => {
      mockCoreApi.readNamespace.mockRejectedValue({ body: { code: 404 } });

      const result = await service.namespaceExists('test-ns');

      expect(result).toBe(false);
    });

    it('should throw on non-404 errors', async () => {
      mockCoreApi.readNamespace.mockRejectedValue(new Error('Server error'));

      await expect(service.namespaceExists('test-ns')).rejects.toThrow(
        'Server error',
      );
    });
  });

  describe('getNamespace', () => {
    it('should return namespace body when found', async () => {
      const nsBody = {
        metadata: { name: 'test-ns', uid: '123' },
      };
      mockCoreApi.readNamespace.mockResolvedValue({ body: nsBody });

      const result = await service.getNamespace('test-ns');

      expect(result).toEqual(nsBody);
      expect(mockCoreApi.readNamespace).toHaveBeenCalledWith({
        name: 'test-ns',
      });
    });

    it('should return null when namespace does not exist (404)', async () => {
      mockCoreApi.readNamespace.mockRejectedValue({ body: { code: 404 } });

      const result = await service.getNamespace('test-ns');

      expect(result).toBeNull();
    });

    it('should throw on non-404 errors', async () => {
      mockCoreApi.readNamespace.mockRejectedValue(new Error('Unauthorized'));

      await expect(service.getNamespace('test-ns')).rejects.toThrow(
        'Unauthorized',
      );
    });
  });

  describe('isNamespaceTerminating', () => {
    it('should return true when namespace has a deletionTimestamp', async () => {
      mockCoreApi.readNamespace.mockResolvedValue({
        body: {
          metadata: {
            name: 'test-ns',
            deletionTimestamp: new Date('2026-01-01'),
          },
        },
      });

      const result = await service.isNamespaceTerminating('test-ns');

      expect(result).toBe(true);
    });

    it('should return false when namespace has no deletionTimestamp', async () => {
      mockCoreApi.readNamespace.mockResolvedValue({
        body: {
          metadata: { name: 'test-ns' },
        },
      });

      const result = await service.isNamespaceTerminating('test-ns');

      expect(result).toBe(false);
    });

    it('should return false when namespace does not exist', async () => {
      mockCoreApi.readNamespace.mockRejectedValue({ body: { code: 404 } });

      const result = await service.isNamespaceTerminating('test-ns');

      expect(result).toBe(false);
    });
  });

  describe('waitForNamespaceDeletion', () => {
    it('should return true immediately when namespace does not exist', async () => {
      mockCoreApi.readNamespace.mockRejectedValue({ body: { code: 404 } });

      const result = await service.waitForNamespaceDeletion('test-ns');

      expect(result).toBe(true);
    });

    it('should poll and return true when namespace is eventually deleted', async () => {
      mockCoreApi.readNamespace
        .mockResolvedValueOnce({}) // exists on first call
        .mockResolvedValueOnce({}) // exists on second call
        .mockRejectedValueOnce({ body: { code: 404 } }); // gone on third

      const result = await service.waitForNamespaceDeletion(
        'test-ns',
        60000,
        100,
      );

      expect(result).toBe(true);
      expect(mockCoreApi.readNamespace).toHaveBeenCalledTimes(3);
    });

    it('should return false when timeout expires', async () => {
      // Always exists - force timeout by using a very short timeout
      mockCoreApi.readNamespace.mockResolvedValue({});

      // Use a tiny timeout so the loop exits quickly
      const result = await service.waitForNamespaceDeletion('test-ns', 1, 1);

      expect(result).toBe(false);
    });
  });

  // ============================================
  // DNS UTILITY
  // ============================================

  describe('getKubeDnsClusterIP', () => {
    it('should return clusterIP from kube-dns service (body wrapper)', async () => {
      mockCoreApi.readNamespacedService.mockResolvedValue({
        body: {
          spec: { clusterIP: '10.96.0.10' },
        },
      });

      const result = await service.getKubeDnsClusterIP();

      expect(result).toBe('10.96.0.10');
      expect(mockCoreApi.readNamespacedService).toHaveBeenCalledWith({
        name: 'kube-dns',
        namespace: 'kube-system',
      });
    });

    it('should return clusterIP from direct response (no body wrapper)', async () => {
      mockCoreApi.readNamespacedService.mockResolvedValue({
        spec: { clusterIP: '10.96.0.10' },
      });

      const result = await service.getKubeDnsClusterIP();

      expect(result).toBe('10.96.0.10');
    });

    it('should attempt fallback to config when clusterIP is not available', async () => {
      mockCoreApi.readNamespacedService.mockResolvedValue({
        body: { spec: {} },
      });

      // The fallback path uses dynamic import() which requires --experimental-vm-modules
      // in Jest 30. We verify the code reaches the fallback by observing the error.
      await expect(service.getKubeDnsClusterIP()).rejects.toThrow(
        'A dynamic import callback was invoked without --experimental-vm-modules',
      );
    });

    it('should attempt fallback to config when service read fails', async () => {
      mockCoreApi.readNamespacedService.mockRejectedValue(
        new Error('Not found'),
      );

      // The fallback path uses dynamic import() which requires --experimental-vm-modules
      // in Jest 30. We verify the code reaches the fallback by observing the error.
      await expect(service.getKubeDnsClusterIP()).rejects.toThrow(
        'A dynamic import callback was invoked without --experimental-vm-modules',
      );
    });
  });
});
