import { InstanceStatus, RunStatus } from '@prisma/client';
import { DeploymentSchedulerService } from './deployment-scheduler.service';

describe('DeploymentSchedulerService', () => {
  let service: DeploymentSchedulerService;

  const mockPrisma: any = {
    run: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    namespaceInstance: {
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    instanceItem: {
      findMany: jest.fn(),
    },
  };

  const mockDeployer: any = {
    deploy: jest.fn().mockResolvedValue(undefined),
  };

  const mockRunStorage: any = {
    hasDefinition: jest.fn(),
    readDefinition: jest.fn(),
  };

  const mockConfigService: any = {
    get: jest.fn((key: string) => {
      if (key === 'MAX_CONCURRENT_NAMESPACES') {
        return 5;
      }
      if (key === 'MAX_BOOTING_NAMESPACES') {
        return 3;
      }
      return undefined;
    }),
  };

  const mockTelemetry: any = {
    track: jest.fn(),
  };

  beforeEach(() => {
    service = new DeploymentSchedulerService(
      mockPrisma,
      mockDeployer,
      mockRunStorage,
      mockConfigService,
      mockTelemetry,
    );
    jest.clearAllMocks();
  });

  describe('deployPendingInstances', () => {
    it('does nothing if run not found', async () => {
      mockPrisma.run.findUnique.mockResolvedValue(null);

      await service.deployPendingInstances('run-1');

      expect(mockPrisma.namespaceInstance.update).not.toHaveBeenCalled();
      expect(mockDeployer.deploy).not.toHaveBeenCalled();
    });

    it('does nothing if run is COMPLETED', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.COMPLETED,
        instances: [],
      });

      await service.deployPendingInstances('run-1');

      expect(mockDeployer.deploy).not.toHaveBeenCalled();
    });

    it('does nothing if run is CANCELLED', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.CANCELLED,
        instances: [],
      });

      await service.deployPendingInstances('run-1');

      expect(mockDeployer.deploy).not.toHaveBeenCalled();
    });

    it('does nothing if run is FAILED', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.FAILED,
        instances: [],
      });

      await service.deployPendingInstances('run-1');

      expect(mockDeployer.deploy).not.toHaveBeenCalled();
    });

    it('deploys pending instances up to available slots', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.RUNNING,
        instances: [
          { id: 'inst-1', status: InstanceStatus.PENDING },
          { id: 'inst-2', status: InstanceStatus.PENDING },
        ],
      });
      mockRunStorage.hasDefinition.mockResolvedValue(true);
      mockRunStorage.readDefinition.mockResolvedValue({
        name: 'test',
        items: [],
      });
      mockPrisma.instanceItem.findMany.mockResolvedValue([]);

      await service.deployPendingInstances('run-1');

      expect(mockPrisma.namespaceInstance.updateMany).toHaveBeenCalledWith({
        where: { id: 'inst-1', status: InstanceStatus.PENDING },
        data: { status: InstanceStatus.STARTING },
      });
      expect(mockPrisma.namespaceInstance.updateMany).toHaveBeenCalledWith({
        where: { id: 'inst-2', status: InstanceStatus.PENDING },
        data: { status: InstanceStatus.STARTING },
      });
    });

    it('skips pending instances without definitions', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.RUNNING,
        instances: [
          { id: 'inst-1', status: InstanceStatus.PENDING },
          { id: 'inst-2', status: InstanceStatus.PENDING },
        ],
      });
      mockRunStorage.hasDefinition
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      mockRunStorage.readDefinition.mockResolvedValue({
        name: 'test',
        items: [],
      });
      mockPrisma.instanceItem.findMany.mockResolvedValue([]);

      await service.deployPendingInstances('run-1');

      expect(mockPrisma.namespaceInstance.updateMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.namespaceInstance.updateMany).toHaveBeenCalledWith({
        where: { id: 'inst-2', status: InstanceStatus.PENDING },
        data: { status: InstanceStatus.STARTING },
      });
    });

    it('respects maxConcurrentTests limit', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.RUNNING,
        instances: [
          { id: 'active-1', status: InstanceStatus.RUNNING },
          { id: 'active-2', status: InstanceStatus.RUNNING },
          { id: 'active-3', status: InstanceStatus.RUNNING },
          { id: 'active-4', status: InstanceStatus.STARTING },
          { id: 'active-5', status: InstanceStatus.STARTING },
          { id: 'pending-1', status: InstanceStatus.PENDING },
        ],
      });
      mockRunStorage.hasDefinition.mockResolvedValue(true);

      await service.deployPendingInstances('run-1');

      expect(mockPrisma.namespaceInstance.update).not.toHaveBeenCalled();
    });

    it('respects maxBootingTests limit', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.RUNNING,
        instances: [
          { id: 'starting-1', status: InstanceStatus.STARTING },
          { id: 'starting-2', status: InstanceStatus.STARTING },
          { id: 'starting-3', status: InstanceStatus.STARTING },
          { id: 'pending-1', status: InstanceStatus.PENDING },
        ],
      });
      mockRunStorage.hasDefinition.mockResolvedValue(true);

      await service.deployPendingInstances('run-1');

      expect(mockPrisma.namespaceInstance.update).not.toHaveBeenCalled();
    });

    it('counts STOPPING and TERMINATING as active', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.RUNNING,
        instances: [
          { id: 'stop-1', status: InstanceStatus.STOPPING },
          { id: 'term-1', status: InstanceStatus.TERMINATING },
          { id: 'run-1', status: InstanceStatus.RUNNING },
          { id: 'run-2', status: InstanceStatus.RUNNING },
          { id: 'run-3', status: InstanceStatus.RUNNING },
          { id: 'pending-1', status: InstanceStatus.PENDING },
        ],
      });

      await service.deployPendingInstances('run-1');

      expect(mockPrisma.namespaceInstance.update).not.toHaveBeenCalled();
    });

    it('deploys for PENDING run status', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.PENDING,
        instances: [{ id: 'inst-1', status: InstanceStatus.PENDING }],
      });
      mockRunStorage.hasDefinition.mockResolvedValue(true);
      mockRunStorage.readDefinition.mockResolvedValue({
        name: 'test',
        items: [],
      });
      mockPrisma.instanceItem.findMany.mockResolvedValue([]);

      await service.deployPendingInstances('run-1');

      expect(mockPrisma.namespaceInstance.updateMany).toHaveBeenCalledWith({
        where: { id: 'inst-1', status: InstanceStatus.PENDING },
        data: { status: InstanceStatus.STARTING },
      });
    });
  });

  describe('checkRunCompletion', () => {
    it('does nothing if run not found', async () => {
      mockPrisma.run.findUnique.mockResolvedValue(null);

      await service.checkRunCompletion('run-1');

      expect(mockPrisma.run.update).not.toHaveBeenCalled();
    });

    it('does nothing if run already COMPLETED', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.COMPLETED,
        instances: [],
      });

      await service.checkRunCompletion('run-1');

      expect(mockPrisma.run.update).not.toHaveBeenCalled();
    });

    it('does nothing if run already FAILED', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.FAILED,
        instances: [],
      });

      await service.checkRunCompletion('run-1');

      expect(mockPrisma.run.update).not.toHaveBeenCalled();
    });

    it('does nothing if run already CANCELLED', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.CANCELLED,
        instances: [],
      });

      await service.checkRunCompletion('run-1');

      expect(mockPrisma.run.update).not.toHaveBeenCalled();
    });

    it('marks run COMPLETED when all instances have PASSED tests', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.RUNNING,
        createdAt: new Date('2026-01-01'),
        instances: [
          {
            id: 'inst-1',
            status: InstanceStatus.STOPPED,
            testStatus: 'PASSED',
          },
          {
            id: 'inst-2',
            status: InstanceStatus.STOPPED,
            testStatus: 'PASSED',
          },
        ],
      });

      await service.checkRunCompletion('run-1');

      expect(mockPrisma.run.update).toHaveBeenCalledWith({
        where: { id: 'run-1' },
        data: {
          status: RunStatus.COMPLETED,
          completedAt: expect.any(Date),
        },
      });
    });

    it('marks run FAILED when any instance has FAILED test', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.RUNNING,
        createdAt: new Date('2026-01-01'),
        instances: [
          {
            id: 'inst-1',
            status: InstanceStatus.STOPPED,
            testStatus: 'PASSED',
          },
          {
            id: 'inst-2',
            status: InstanceStatus.STOPPED,
            testStatus: 'FAILED',
          },
        ],
      });

      await service.checkRunCompletion('run-1');

      expect(mockPrisma.run.update).toHaveBeenCalledWith({
        where: { id: 'run-1' },
        data: {
          status: RunStatus.FAILED,
          completedAt: expect.any(Date),
        },
      });
    });

    it('marks run FAILED when instance status is FAILED', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.RUNNING,
        createdAt: new Date('2026-01-01'),
        instances: [
          {
            id: 'inst-1',
            status: InstanceStatus.FAILED,
            testStatus: null,
          },
        ],
      });

      await service.checkRunCompletion('run-1');

      expect(mockPrisma.run.update).toHaveBeenCalledWith({
        where: { id: 'run-1' },
        data: {
          status: RunStatus.FAILED,
          completedAt: expect.any(Date),
        },
      });
    });

    it('does not complete if instances are still RUNNING', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.RUNNING,
        instances: [
          {
            id: 'inst-1',
            status: InstanceStatus.STOPPED,
            testStatus: 'PASSED',
          },
          {
            id: 'inst-2',
            status: InstanceStatus.RUNNING,
            testStatus: null,
          },
        ],
      });

      await service.checkRunCompletion('run-1');

      expect(mockPrisma.run.update).not.toHaveBeenCalled();
    });

    it('does not complete if instances are still STARTING', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.RUNNING,
        instances: [
          {
            id: 'inst-1',
            status: InstanceStatus.STARTING,
            testStatus: null,
          },
        ],
      });

      await service.checkRunCompletion('run-1');

      expect(mockPrisma.run.update).not.toHaveBeenCalled();
    });

    it('treats PENDING instance without definition as failed', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.RUNNING,
        createdAt: new Date('2026-01-01'),
        instances: [
          {
            id: 'inst-1',
            status: InstanceStatus.PENDING,
            testStatus: null,
          },
        ],
      });
      mockRunStorage.hasDefinition.mockResolvedValue(false);

      await service.checkRunCompletion('run-1');

      expect(mockPrisma.run.update).toHaveBeenCalledWith({
        where: { id: 'run-1' },
        data: {
          status: RunStatus.FAILED,
          completedAt: expect.any(Date),
        },
      });
    });

    it('does not complete if PENDING instance has definition (waiting for deploy)', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.RUNNING,
        instances: [
          {
            id: 'inst-1',
            status: InstanceStatus.PENDING,
            testStatus: null,
          },
        ],
      });
      mockRunStorage.hasDefinition.mockResolvedValue(true);

      await service.checkRunCompletion('run-1');

      expect(mockPrisma.run.update).not.toHaveBeenCalled();
    });

    it('tracks telemetry on completion', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.RUNNING,
        createdAt: new Date('2026-01-01'),
        instances: [
          {
            id: 'inst-1',
            status: InstanceStatus.STOPPED,
            testStatus: 'PASSED',
          },
          {
            id: 'inst-2',
            status: InstanceStatus.FAILED,
            testStatus: 'FAILED',
          },
        ],
      });

      await service.checkRunCompletion('run-1');

      expect(mockTelemetry.track).toHaveBeenCalledWith('ct_run_completed', {
        passed_count: 1,
        failed_count: 1,
        run_duration_ms: expect.any(Number),
      });
    });

    it('treats STOPPING instances as terminal', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.RUNNING,
        createdAt: new Date('2026-01-01'),
        instances: [
          {
            id: 'inst-1',
            status: InstanceStatus.STOPPING,
            testStatus: 'PASSED',
          },
        ],
      });

      await service.checkRunCompletion('run-1');

      expect(mockPrisma.run.update).toHaveBeenCalledWith({
        where: { id: 'run-1' },
        data: {
          status: RunStatus.COMPLETED,
          completedAt: expect.any(Date),
        },
      });
    });

    it('treats TERMINATING instances as terminal', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.RUNNING,
        createdAt: new Date('2026-01-01'),
        instances: [
          {
            id: 'inst-1',
            status: InstanceStatus.TERMINATING,
            testStatus: 'PASSED',
          },
        ],
      });

      await service.checkRunCompletion('run-1');

      expect(mockPrisma.run.update).toHaveBeenCalledWith({
        where: { id: 'run-1' },
        data: {
          status: RunStatus.COMPLETED,
          completedAt: expect.any(Date),
        },
      });
    });
  });

  describe('handleInstancesStopped', () => {
    it('calls checkRunCompletion and deployPendingInstances for each unique run', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.RUNNING,
        instances: [
          {
            id: 'inst-1',
            status: InstanceStatus.RUNNING,
            testStatus: null,
          },
        ],
      });

      await service.handleInstancesStopped(['run-1']);

      expect(mockPrisma.run.findUnique).toHaveBeenCalled();
    });

    it('deduplicates run IDs', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.COMPLETED,
        instances: [],
      });

      await service.handleInstancesStopped(['run-1', 'run-1', 'run-1']);

      const calls = mockPrisma.run.findUnique.mock.calls;
      const runIds = calls.map((c: any) => c[0].where.id);
      expect(
        runIds.filter((id: string) => id === 'run-1').length,
      ).toBeLessThanOrEqual(2);
    });

    it('handles errors for individual runs without stopping others', async () => {
      mockPrisma.run.findUnique
        .mockRejectedValueOnce(new Error('DB error'))
        .mockResolvedValueOnce({
          id: 'run-2',
          status: RunStatus.RUNNING,
          createdAt: new Date('2026-01-01'),
          instances: [
            {
              id: 'inst-2',
              status: InstanceStatus.STOPPED,
              testStatus: 'PASSED',
            },
          ],
        })
        .mockResolvedValue({
          id: 'run-2',
          status: RunStatus.RUNNING,
          instances: [],
        });

      await service.handleInstancesStopped(['run-1', 'run-2']);

      expect(mockPrisma.run.update).toHaveBeenCalledWith({
        where: { id: 'run-2' },
        data: {
          status: RunStatus.COMPLETED,
          completedAt: expect.any(Date),
        },
      });
    });
  });
});
