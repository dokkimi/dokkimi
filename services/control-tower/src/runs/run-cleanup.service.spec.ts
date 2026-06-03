import { InstanceStatus, RunStatus } from '@prisma/client';
import { RunCleanupService } from './run-cleanup.service';

describe('RunCleanupService', () => {
  let service: RunCleanupService;

  const mockPrisma: any = {
    run: {
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    namespaceInstance: {
      update: jest.fn(),
    },
  };

  const mockLifecycle: any = {
    stopInstance: jest.fn().mockResolvedValue(undefined),
  };

  const mockRunStorage: any = {
    deleteInstance: jest.fn().mockResolvedValue(undefined),
    deleteGeneratedFiles: jest.fn().mockResolvedValue(undefined),
  };

  const mockRegistryService: any = {
    clearCredentials: jest.fn(),
  };

  beforeEach(() => {
    service = new RunCleanupService(
      mockPrisma,
      mockLifecycle,
      mockRunStorage,
      mockRegistryService,
    );
    jest.clearAllMocks();
  });

  describe('stopInstances', () => {
    it('stops STARTING and RUNNING instances via lifecycle', async () => {
      const instances = [
        { id: 'inst-1', status: InstanceStatus.STARTING },
        { id: 'inst-2', status: InstanceStatus.RUNNING },
      ] as any[];

      await service.stopInstances(instances);

      expect(mockLifecycle.stopInstance).toHaveBeenCalledWith('inst-1');
      expect(mockLifecycle.stopInstance).toHaveBeenCalledWith('inst-2');
    });

    it('does not call lifecycle.stopInstance for PENDING instances', async () => {
      const instances = [
        { id: 'inst-1', status: InstanceStatus.PENDING },
      ] as any[];

      await service.stopInstances(instances);

      expect(mockLifecycle.stopInstance).not.toHaveBeenCalled();
    });

    it('marks non-terminal instances as FAILED', async () => {
      const instances = [
        { id: 'inst-1', status: InstanceStatus.PENDING },
        { id: 'inst-2', status: InstanceStatus.RUNNING },
      ] as any[];

      await service.stopInstances(instances);

      expect(mockPrisma.namespaceInstance.update).toHaveBeenCalledWith({
        where: { id: 'inst-1' },
        data: { status: InstanceStatus.FAILED, stoppedAt: expect.any(Date) },
      });
      expect(mockPrisma.namespaceInstance.update).toHaveBeenCalledWith({
        where: { id: 'inst-2' },
        data: { status: InstanceStatus.FAILED, stoppedAt: expect.any(Date) },
      });
    });

    it('does not update already-terminal instances', async () => {
      const instances = [
        { id: 'inst-1', status: InstanceStatus.STOPPED },
        { id: 'inst-2', status: InstanceStatus.FAILED },
        { id: 'inst-3', status: InstanceStatus.STOPPING },
        { id: 'inst-4', status: InstanceStatus.TERMINATING },
      ] as any[];

      await service.stopInstances(instances);

      expect(mockPrisma.namespaceInstance.update).not.toHaveBeenCalled();
    });

    it('handles lifecycle.stopInstance failure gracefully', async () => {
      mockLifecycle.stopInstance.mockRejectedValue(new Error('docker error'));
      const instances = [
        { id: 'inst-1', status: InstanceStatus.RUNNING },
      ] as any[];

      await service.stopInstances(instances);

      expect(mockPrisma.namespaceInstance.update).toHaveBeenCalledWith({
        where: { id: 'inst-1' },
        data: { status: InstanceStatus.FAILED, stoppedAt: expect.any(Date) },
      });
    });

    it('handles empty instances array', async () => {
      await service.stopInstances([]);

      expect(mockLifecycle.stopInstance).not.toHaveBeenCalled();
      expect(mockPrisma.namespaceInstance.update).not.toHaveBeenCalled();
    });
  });

  describe('teardownExistingRuns', () => {
    it('stops instances, deletes runs, cleans storage, deletes secrets', async () => {
      mockPrisma.run.findMany.mockResolvedValue([
        {
          id: 'run-1',
          instances: [
            { id: 'inst-1', status: InstanceStatus.RUNNING },
            { id: 'inst-2', status: InstanceStatus.STOPPED },
          ],
        },
      ]);

      await service.teardownExistingRuns();

      expect(mockLifecycle.stopInstance).toHaveBeenCalledWith('inst-1');
      expect(mockPrisma.run.delete).toHaveBeenCalledWith({
        where: { id: 'run-1' },
      });
      expect(mockRunStorage.deleteInstance).toHaveBeenCalledWith('inst-1');
      expect(mockRunStorage.deleteInstance).toHaveBeenCalledWith('inst-2');
      expect(mockRegistryService.clearCredentials).toHaveBeenCalledWith(
        'run-1',
      );
      expect(mockRunStorage.deleteGeneratedFiles).toHaveBeenCalled();
    });

    it('handles multiple existing runs', async () => {
      mockPrisma.run.findMany.mockResolvedValue([
        { id: 'run-1', instances: [] },
        { id: 'run-2', instances: [] },
      ]);

      await service.teardownExistingRuns();

      expect(mockPrisma.run.delete).toHaveBeenCalledTimes(2);
      expect(mockRegistryService.clearCredentials).toHaveBeenCalledTimes(2);
    });

    it('handles no existing runs', async () => {
      mockPrisma.run.findMany.mockResolvedValue([]);

      await service.teardownExistingRuns();

      expect(mockPrisma.run.delete).not.toHaveBeenCalled();
      expect(mockRunStorage.deleteGeneratedFiles).toHaveBeenCalled();
    });

    it('clears registry credentials for each run', async () => {
      mockPrisma.run.findMany.mockResolvedValue([
        { id: 'run-1', instances: [] },
      ]);

      await service.teardownExistingRuns();

      expect(mockRegistryService.clearCredentials).toHaveBeenCalledWith(
        'run-1',
      );
    });
  });

  describe('recoverOrphanedRuns', () => {
    it('marks orphaned PENDING/RUNNING runs as CANCELLED', async () => {
      mockPrisma.run.findMany.mockResolvedValue([
        {
          id: 'orphan-1',
          status: RunStatus.RUNNING,
          instances: [{ id: 'inst-1', status: InstanceStatus.RUNNING }],
        },
        {
          id: 'orphan-2',
          status: RunStatus.PENDING,
          instances: [],
        },
      ]);

      await service.recoverOrphanedRuns();

      expect(mockPrisma.run.update).toHaveBeenCalledWith({
        where: { id: 'orphan-1' },
        data: {
          status: RunStatus.CANCELLED,
          cancelledAt: expect.any(Date),
        },
      });
      expect(mockPrisma.run.update).toHaveBeenCalledWith({
        where: { id: 'orphan-2' },
        data: {
          status: RunStatus.CANCELLED,
          cancelledAt: expect.any(Date),
        },
      });
    });

    it('stops active instances of orphaned runs', async () => {
      mockPrisma.run.findMany.mockResolvedValue([
        {
          id: 'orphan-1',
          status: RunStatus.RUNNING,
          instances: [{ id: 'inst-1', status: InstanceStatus.RUNNING }],
        },
      ]);

      await service.recoverOrphanedRuns();

      expect(mockLifecycle.stopInstance).toHaveBeenCalledWith('inst-1');
    });

    it('does nothing if no orphaned runs', async () => {
      mockPrisma.run.findMany.mockResolvedValue([]);

      await service.recoverOrphanedRuns();

      expect(mockPrisma.run.update).not.toHaveBeenCalled();
    });

    it('queries only PENDING and RUNNING statuses', async () => {
      mockPrisma.run.findMany.mockResolvedValue([]);

      await service.recoverOrphanedRuns();

      expect(mockPrisma.run.findMany).toHaveBeenCalledWith({
        where: {
          status: { in: [RunStatus.PENDING, RunStatus.RUNNING] },
        },
        include: { instances: true },
      });
    });
  });
});
