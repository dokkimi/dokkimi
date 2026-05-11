import { Test, TestingModule } from '@nestjs/testing';
import { NamespaceLifecycleService } from './namespace-lifecycle.service';
import { KubernetesClientService } from './kubernetes/kubernetes-client.service';
import { NamespaceInstanceService } from '../namespace/namespace-instance.service';
import { InstanceItemService } from '../namespace/instance-item.service';
import { InstanceStatus } from '@prisma/client';

describe('NamespaceLifecycleService', () => {
  let service: NamespaceLifecycleService;

  const mockNamespaceInstanceService = {
    findInstance: jest.fn(),
    updateInstanceStatus: jest.fn(),
  };

  const mockInstanceItemService = {
    findInstanceItems: jest.fn(),
    updateInstanceItemStatus: jest.fn(),
    updateInstanceItemReadiness: jest.fn(),
    markAllStopping: jest.fn(),
  };

  const mockK8sClient = {
    deleteNamespace: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NamespaceLifecycleService,
        {
          provide: KubernetesClientService,
          useValue: mockK8sClient,
        },
        {
          provide: NamespaceInstanceService,
          useValue: mockNamespaceInstanceService,
        },
        {
          provide: InstanceItemService,
          useValue: mockInstanceItemService,
        },
      ],
    }).compile();

    service = module.get<NamespaceLifecycleService>(NamespaceLifecycleService);
  });

  describe('stopInstance', () => {
    const instanceId = 'instance-1';
    const k8sNamespace = 'dokkimi-ns-1';

    const mockInstance = {
      id: instanceId,
      k8sNamespace,
    };

    const mockItems = [
      { id: 'item-1', name: 'service-a' },
      { id: 'item-2', name: 'service-b' },
    ];

    beforeEach(() => {
      mockNamespaceInstanceService.findInstance.mockResolvedValue(mockInstance);
      mockNamespaceInstanceService.updateInstanceStatus.mockResolvedValue(
        undefined,
      );
      mockInstanceItemService.findInstanceItems.mockResolvedValue(mockItems);
      mockInstanceItemService.updateInstanceItemStatus.mockResolvedValue(
        undefined,
      );
      mockInstanceItemService.updateInstanceItemReadiness.mockResolvedValue(
        undefined,
      );
      mockK8sClient.deleteNamespace.mockResolvedValue(undefined);
    });

    it('should set instance status to STOPPING, then TERMINATING', async () => {
      await service.stopInstance(instanceId);

      expect(
        mockNamespaceInstanceService.updateInstanceStatus,
      ).toHaveBeenCalledTimes(2);
      expect(
        mockNamespaceInstanceService.updateInstanceStatus,
      ).toHaveBeenNthCalledWith(1, instanceId, InstanceStatus.STOPPING);
      expect(
        mockNamespaceInstanceService.updateInstanceStatus,
      ).toHaveBeenNthCalledWith(2, instanceId, InstanceStatus.TERMINATING);
    });

    it('should mark all instance items as STOPPING with UNKNOWN readiness', async () => {
      await service.stopInstance(instanceId);

      expect(mockInstanceItemService.markAllStopping).toHaveBeenCalledWith(
        instanceId,
      );
    });

    it('should delete the k8s namespace', async () => {
      await service.stopInstance(instanceId);

      expect(mockK8sClient.deleteNamespace).toHaveBeenCalledWith(k8sNamespace);
    });

    it('should fall back to dokkimi-{instanceId} when k8sNamespace is null', async () => {
      mockNamespaceInstanceService.findInstance.mockResolvedValue({
        id: instanceId,
        k8sNamespace: null,
      });

      await service.stopInstance(instanceId);

      expect(mockK8sClient.deleteNamespace).toHaveBeenCalledWith(
        `dokkimi-${instanceId}`,
      );
    });

    it('should set status to FAILED and rethrow on error', async () => {
      const error = new Error('k8s failure');
      mockK8sClient.deleteNamespace.mockRejectedValue(error);

      await expect(service.stopInstance(instanceId)).rejects.toThrow(
        'k8s failure',
      );

      expect(
        mockNamespaceInstanceService.updateInstanceStatus,
      ).toHaveBeenCalledWith(instanceId, InstanceStatus.FAILED);
    });

    it('should still throw original error if setting FAILED status also fails', async () => {
      const originalError = new Error('k8s failure');
      mockK8sClient.deleteNamespace.mockRejectedValue(originalError);
      mockNamespaceInstanceService.updateInstanceStatus
        .mockResolvedValueOnce(undefined) // STOPPING succeeds
        .mockRejectedValueOnce(new Error('db error')); // FAILED fails

      await expect(service.stopInstance(instanceId)).rejects.toThrow(
        'k8s failure',
      );
    });
  });
});
