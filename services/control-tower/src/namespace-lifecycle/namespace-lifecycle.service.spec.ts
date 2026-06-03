import { Test, TestingModule } from '@nestjs/testing';
import { NamespaceLifecycleService } from './namespace-lifecycle.service';
import { DockerDeployerService } from './docker/docker-deployer.service';
import { PrismaService } from '../prisma/prisma.service';
import { NamespaceInstanceService } from '../namespace/namespace-instance.service';
import { InstanceItemService } from '../namespace/instance-item.service';
import { InstanceStatus, ItemStatus } from '@prisma/client';

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

  const mockDockerDeployer = {
    teardown: jest.fn(),
  };

  const mockPrisma = {
    namespaceInstance: {
      update: jest.fn(),
    },
    instanceItem: {
      updateMany: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NamespaceLifecycleService,
        {
          provide: DockerDeployerService,
          useValue: mockDockerDeployer,
        },
        {
          provide: PrismaService,
          useValue: mockPrisma,
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

    beforeEach(() => {
      mockNamespaceInstanceService.updateInstanceStatus.mockResolvedValue(
        undefined,
      );
      mockInstanceItemService.markAllStopping.mockResolvedValue(undefined);
      mockDockerDeployer.teardown.mockResolvedValue(undefined);
      mockPrisma.namespaceInstance.update.mockResolvedValue(undefined);
      mockPrisma.instanceItem.updateMany.mockResolvedValue(undefined);
    });

    it('should set instance status to STOPPING', async () => {
      await service.stopInstance(instanceId);

      expect(
        mockNamespaceInstanceService.updateInstanceStatus,
      ).toHaveBeenCalledWith(instanceId, InstanceStatus.STOPPING);
    });

    it('should mark all instance items as STOPPING', async () => {
      await service.stopInstance(instanceId);

      expect(mockInstanceItemService.markAllStopping).toHaveBeenCalledWith(
        instanceId,
      );
    });

    it('should call docker teardown', async () => {
      await service.stopInstance(instanceId);

      expect(mockDockerDeployer.teardown).toHaveBeenCalledWith(instanceId);
    });

    it('should mark instance as STOPPED after teardown', async () => {
      await service.stopInstance(instanceId);

      expect(mockPrisma.namespaceInstance.update).toHaveBeenCalledWith({
        where: { id: instanceId },
        data: {
          status: InstanceStatus.STOPPED,
          stoppedAt: expect.any(Date),
        },
      });
    });

    it('should mark all items as STOPPED after teardown', async () => {
      await service.stopInstance(instanceId);

      expect(mockPrisma.instanceItem.updateMany).toHaveBeenCalledWith({
        where: { instanceId },
        data: { status: ItemStatus.STOPPED },
      });
    });

    it('should set status to FAILED and rethrow on error', async () => {
      const error = new Error('docker failure');
      mockDockerDeployer.teardown.mockRejectedValue(error);

      await expect(service.stopInstance(instanceId)).rejects.toThrow(
        'docker failure',
      );

      expect(
        mockNamespaceInstanceService.updateInstanceStatus,
      ).toHaveBeenCalledWith(instanceId, InstanceStatus.FAILED);
    });

    it('should still throw original error if setting FAILED status also fails', async () => {
      const originalError = new Error('docker failure');
      mockDockerDeployer.teardown.mockRejectedValue(originalError);
      mockNamespaceInstanceService.updateInstanceStatus
        .mockResolvedValueOnce(undefined) // STOPPING succeeds
        .mockRejectedValueOnce(new Error('db error')); // FAILED fails

      await expect(service.stopInstance(instanceId)).rejects.toThrow(
        'docker failure',
      );
    });
  });
});
