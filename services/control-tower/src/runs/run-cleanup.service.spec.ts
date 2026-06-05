import { InstanceStatus, RunStatus } from '@prisma/client';
import { RunCleanupService } from './run-cleanup.service';

jest.mock('@dokkimi/config', () => ({
  ...jest.requireActual('@dokkimi/config'),
  getMaxRunHistory: jest.fn().mockReturnValue(2),
}));

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
    $queryRaw: jest.fn().mockResolvedValue(undefined),
  };

  const mockLifecycle: any = {
    stopInstance: jest.fn().mockResolvedValue(undefined),
  };

  const mockRunStorage: any = {
    deleteInstance: jest.fn().mockResolvedValue(undefined),
    deleteRunDir: jest.fn().mockResolvedValue(undefined),
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

  describe('prepareForNewRun', () => {
    it('stops active runs for the given project and prunes old completed runs', async () => {
      // First call: active runs query
      mockPrisma.run.findMany
        .mockResolvedValueOnce([
          {
            id: 'active-run',
            instances: [{ id: 'inst-1', status: InstanceStatus.RUNNING }],
          },
        ])
        // Second call: completed runs query
        .mockResolvedValueOnce([
          {
            id: 'completed-1',
            createdAt: new Date('2026-01-03'),
            instances: [{ id: 'inst-2' }],
          },
          {
            id: 'completed-2',
            projectPath: '/my/project',
            createdAt: new Date('2026-01-02'),
            instances: [{ id: 'inst-3' }],
          },
          {
            id: 'completed-3',
            projectPath: '/my/project',
            createdAt: new Date('2026-01-01'),
            instances: [{ id: 'inst-4' }],
          },
        ]);

      await service.prepareForNewRun('/my/project');

      // Active run should be cancelled
      expect(mockPrisma.run.update).toHaveBeenCalledWith({
        where: { id: 'active-run' },
        data: {
          status: RunStatus.CANCELLED,
          cancelledAt: expect.any(Date),
        },
      });
      expect(mockRegistryService.clearCredentials).toHaveBeenCalledWith(
        'active-run',
      );

      // With maxRunHistory=2, keep 1 completed run (the new run occupies a slot).
      // completed-2 and completed-3 should be pruned.
      expect(mockPrisma.run.delete).toHaveBeenCalledWith({
        where: { id: 'completed-2' },
      });
      expect(mockRunStorage.deleteRunDir).toHaveBeenCalledWith(
        '/my/project',
        new Date('2026-01-02'),
      );
      expect(mockPrisma.run.delete).toHaveBeenCalledWith({
        where: { id: 'completed-3' },
      });
      expect(mockRunStorage.deleteRunDir).toHaveBeenCalledWith(
        '/my/project',
        new Date('2026-01-01'),
      );

      // Newest completed run should be preserved
      expect(mockPrisma.run.delete).not.toHaveBeenCalledWith({
        where: { id: 'completed-1' },
      });
    });

    it('scopes active run query by projectPath', async () => {
      mockPrisma.run.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.prepareForNewRun('/my/project');

      expect(mockPrisma.run.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            projectPath: '/my/project',
          }),
        }),
      );
    });

    it('handles no active or completed runs', async () => {
      mockPrisma.run.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.prepareForNewRun('/my/project');

      expect(mockPrisma.run.update).not.toHaveBeenCalled();
      expect(mockPrisma.run.delete).not.toHaveBeenCalled();
    });

    it('does not prune when completed runs are within limit', async () => {
      mockPrisma.run.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          id: 'completed-1',
          createdAt: new Date('2026-01-02'),
          instances: [],
        },
      ]);

      await service.prepareForNewRun('/my/project');

      expect(mockPrisma.run.delete).not.toHaveBeenCalled();
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
