import { InstanceStatus, RunStatus } from '@prisma/client';
import { RunsService } from './runs.service';
import { SubmitInstanceDto } from './dto/submit-instance.dto';

describe('RunsService', () => {
  let service: RunsService;

  const mockPrisma = {
    run: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    namespaceInstance: {
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    instanceItem: {
      create: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    client: {
      $transaction: jest.fn((fn: (tx: any) => Promise<any>) => fn(mockPrisma)),
    },
  };

  const mockRunStorage = {
    writeDefinition: jest.fn(),
    writeInitFiles: jest.fn(),
    hasDefinition: jest.fn(),
    readDefinition: jest.fn(),
    deleteInstance: jest.fn(),
    deleteRunDir: jest.fn(),
    deleteGeneratedFiles: jest.fn(),
    registerInstance: jest.fn(),
  };

  const mockLifecycle = {
    stopInstance: jest.fn().mockResolvedValue(undefined),
  };

  const mockRegistryService = {
    storeCredentials: jest.fn(),
    clearCredentials: jest.fn(),
    getAuthConfig: jest.fn(),
  };

  const mockTelemetry = {
    track: jest.fn(),
  };

  const mockCleanup = {
    stopInstances: jest.fn().mockResolvedValue(undefined),
    prepareForNewRun: jest.fn().mockResolvedValue(undefined),
    recoverStaleRuns: jest.fn().mockResolvedValue(undefined),
    recoverOrphanedRuns: jest.fn().mockResolvedValue(undefined),
  };

  const mockScheduler = {
    deployPendingInstances: jest.fn().mockResolvedValue(undefined),
    handleInstancesStopped: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    const mockVisualMatch = {
      processInstance: jest.fn().mockResolvedValue({ failures: [] }),
    };

    service = new RunsService(
      mockPrisma as any,
      mockRunStorage as any,
      mockLifecycle as any,
      mockRegistryService as any,
      mockTelemetry as any,
      mockCleanup as any,
      mockScheduler as any,
      mockVisualMatch as any,
    );
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ============================================
  // createRun
  // ============================================

  describe('createRun', () => {
    it('should create a run with instance stubs', async () => {
      mockPrisma.run.findFirst.mockResolvedValue(null);

      const createdRun = {
        id: 'run-1',
        status: RunStatus.PENDING,
        instances: [
          {
            id: 'inst-1',
            name: 'api-tests',
            status: InstanceStatus.PENDING,
          },
          {
            id: 'inst-2',
            name: 'db-tests',
            status: InstanceStatus.PENDING,
          },
        ],
      };
      mockPrisma.run.create.mockResolvedValue(createdRun);

      const result = await service.createRun(['api-tests', 'db-tests']);

      expect(result.runId).toBe('run-1');
      expect(result.instances).toHaveLength(2);
      expect(result.instances[0]).toEqual({
        id: 'inst-1',
        name: 'api-tests',
        status: InstanceStatus.PENDING,
      });
      expect(result.instances[1]).toEqual({
        id: 'inst-2',
        name: 'db-tests',
        status: InstanceStatus.PENDING,
      });
    });

    it('should delegate teardown to cleanup service before creating new one', async () => {
      mockPrisma.run.findFirst.mockResolvedValue(null);
      mockPrisma.run.create.mockResolvedValue({
        id: 'new-run',
        instances: [],
      });

      await service.createRun(['api-tests']);

      expect(mockCleanup.prepareForNewRun).toHaveBeenCalled();
    });

    it('should throw ConflictException if a run is already active', async () => {
      mockCleanup.recoverStaleRuns.mockResolvedValue(undefined);
      mockPrisma.run.findFirst.mockResolvedValue({ id: 'active-run' });

      await expect(service.createRun(['api-tests'])).rejects.toThrow(
        'A run is already in progress',
      );
    });

    it('should store registry credentials when provided', async () => {
      mockPrisma.run.findFirst.mockResolvedValue(null);
      mockPrisma.run.create.mockResolvedValue({ id: 'run-1', instances: [] });

      const creds = [{ registryUrl: 'ghcr.io', username: 'u', password: 'p' }];
      await service.createRun(['api-tests'], creds);

      expect(mockRegistryService.storeCredentials).toHaveBeenCalledWith(
        'run-1',
        creds,
      );
    });

    it('should track telemetry on run creation', async () => {
      mockPrisma.run.findFirst.mockResolvedValue(null);
      mockPrisma.run.create.mockResolvedValue({
        id: 'run-1',
        instances: [{ id: 'inst-1', name: 'test', status: 'PENDING' }],
      });

      await service.createRun(['test']);

      expect(mockTelemetry.track).toHaveBeenCalledWith('ct_run_created', {
        instance_count: 1,
        has_registry_credentials: false,
      });
    });
  });

  // ============================================
  // submitInstance
  // ============================================

  describe('submitInstance', () => {
    const baseDto: SubmitInstanceDto = {
      definition: {
        name: 'api-tests',
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

    beforeEach(() => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.PENDING,
      });
      mockPrisma.namespaceInstance.findUnique.mockResolvedValue({
        id: 'inst-1',
        runId: 'run-1',
        status: InstanceStatus.PENDING,
      });
      mockPrisma.instanceItem.create
        .mockResolvedValueOnce({ id: 'item-1' })
        .mockResolvedValueOnce({ id: 'item-2' });
    });

    it('should create instance items and return PENDING (no deployment)', async () => {
      const result = await service.submitInstance('run-1', 'inst-1', baseDto);

      expect(result.instanceId).toBe('inst-1');
      expect(result.status).toBe('PENDING');

      // Should create InstanceItem records
      expect(mockPrisma.instanceItem.create).toHaveBeenCalledTimes(2);
      expect(mockPrisma.instanceItem.create).toHaveBeenCalledWith({
        data: { instanceId: 'inst-1', itemDefinitionName: 'api-service' },
      });
      expect(mockPrisma.instanceItem.create).toHaveBeenCalledWith({
        data: { instanceId: 'inst-1', itemDefinitionName: 'users-db' },
      });

      // Deployment is triggered by status polling, not on submit
    });

    it('should write definition.json to disk', async () => {
      await service.submitInstance('run-1', 'inst-1', baseDto);

      expect(mockRunStorage.writeDefinition).toHaveBeenCalledWith(
        'inst-1',
        expect.objectContaining({ name: 'api-tests' }),
      );
    });

    it('should update run status to RUNNING on first submission', async () => {
      await service.submitInstance('run-1', 'inst-1', baseDto);

      expect(mockPrisma.run.update).toHaveBeenCalledWith({
        where: { id: 'run-1' },
        data: { status: RunStatus.RUNNING },
      });
    });

    it('should not update run status if already RUNNING', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.RUNNING,
      });

      await service.submitInstance('run-1', 'inst-1', baseDto);

      expect(mockPrisma.run.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: RunStatus.RUNNING }),
        }),
      );
    });

    it('should skip if instance already past PENDING (idempotency)', async () => {
      mockPrisma.namespaceInstance.findUnique.mockResolvedValue({
        id: 'inst-1',
        runId: 'run-1',
        status: InstanceStatus.RUNNING,
      });

      const result = await service.submitInstance('run-1', 'inst-1', baseDto);

      expect(result.status).toBe(InstanceStatus.RUNNING);
      expect(mockPrisma.instanceItem.create).not.toHaveBeenCalled();
    });

    it('should throw if run not found', async () => {
      mockPrisma.run.findUnique.mockResolvedValue(null);

      await expect(
        service.submitInstance('bad-run', 'inst-1', baseDto),
      ).rejects.toThrow('Run bad-run not found');
    });

    it('should throw if instance not in run', async () => {
      mockPrisma.namespaceInstance.findUnique.mockResolvedValue({
        id: 'inst-1',
        runId: 'other-run',
        status: InstanceStatus.PENDING,
      });

      await expect(
        service.submitInstance('run-1', 'inst-1', baseDto),
      ).rejects.toThrow('Instance inst-1 not found in run run-1');
    });

    it('should strip init file content from definition.json on disk', async () => {
      const dtoWithInitFiles: SubmitInstanceDto = {
        definition: {
          name: 'db-tests',
          items: [
            {
              name: 'users-db',
              type: 'DATABASE',
              database: 'postgres',
              initFiles: [
                {
                  filename: 'schema.sql',
                  content: Buffer.from('CREATE TABLE').toString('base64'),
                },
              ],
            },
          ],
        },
      };

      mockPrisma.instanceItem.create.mockResolvedValue({ id: 'item-1' });

      await service.submitInstance('run-1', 'inst-1', dtoWithInitFiles);

      // definition.json should have filename but no content
      const writtenDef = mockRunStorage.writeDefinition.mock.calls[0][1];
      expect(writtenDef.items[0].initFiles[0]).toEqual({
        filename: 'schema.sql',
      });
      expect(writtenDef.items[0].initFiles[0].content).toBeUndefined();
    });
  });

  // ============================================
  // getRunStatus
  // ============================================

  describe('getRunStatus', () => {
    it('should return run and instance statuses', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.RUNNING,
        createdAt: new Date('2026-03-15'),
        completedAt: null,
        cancelledAt: null,
        instances: [
          {
            id: 'inst-1',
            name: 'api-tests',
            status: InstanceStatus.RUNNING,
            testStatus: null,
            errorMessage: null,
            items: [],
          },
        ],
      });

      const result = await service.getRunStatus('run-1');

      expect(result.runId).toBe('run-1');
      expect(result.status).toBe(RunStatus.RUNNING);
      expect(result.instances).toHaveLength(1);
      expect(result.instances[0].name).toBe('api-tests');
    });

    it('should throw if run not found', async () => {
      mockPrisma.run.findUnique.mockResolvedValue(null);

      await expect(service.getRunStatus('bad-run')).rejects.toThrow(
        'Run bad-run not found',
      );
    });
  });

  // ============================================
  // stopCurrentRun
  // ============================================

  describe('stopCurrentRun', () => {
    it('should delegate instance stopping to cleanup and mark run CANCELLED', async () => {
      const instances = [
        { id: 'inst-1', status: InstanceStatus.PENDING },
        { id: 'inst-2', status: InstanceStatus.RUNNING },
        { id: 'inst-3', status: InstanceStatus.STOPPED },
      ];
      mockPrisma.run.findFirst.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.RUNNING,
        instances,
      });

      await service.stopCurrentRun();

      expect(mockCleanup.stopInstances).toHaveBeenCalledWith(instances);

      expect(mockPrisma.run.update).toHaveBeenCalledWith({
        where: { id: 'run-1' },
        data: {
          status: RunStatus.CANCELLED,
          cancelledAt: expect.any(Date),
        },
      });
    });

    it('should return NO_ACTIVE_RUN when nothing is running', async () => {
      mockPrisma.run.findFirst.mockResolvedValue(null);

      const result = await service.stopCurrentRun();

      expect(result).toEqual({ status: 'NO_ACTIVE_RUN' });
    });
  });

  // ============================================
  // handleValidationComplete
  // ============================================

  describe('handleValidationComplete', () => {
    beforeEach(() => {
      mockPrisma.namespaceInstance.update.mockResolvedValue({
        id: 'inst-1',
        runId: 'run-1',
      });
    });

    it('should update instance test status to PASSED', async () => {
      await service.handleValidationComplete('inst-1', true);

      expect(mockPrisma.namespaceInstance.update).toHaveBeenCalledWith({
        where: { id: 'inst-1' },
        data: {
          testStatus: 'PASSED',
          testCompletedAt: expect.any(Date),
          errorMessage: null,
        },
      });
    });

    it('should update instance test status to FAILED with error', async () => {
      await service.handleValidationComplete(
        'inst-1',
        false,
        'assertion failed',
      );

      expect(mockPrisma.namespaceInstance.update).toHaveBeenCalledWith({
        where: { id: 'inst-1' },
        data: {
          testStatus: 'FAILED',
          testCompletedAt: expect.any(Date),
          errorMessage: 'assertion failed',
        },
      });
    });

    it('should initiate namespace teardown', async () => {
      mockLifecycle.stopInstance.mockResolvedValue(undefined);

      await service.handleValidationComplete('inst-1', true);

      expect(mockLifecycle.stopInstance).toHaveBeenCalledWith('inst-1');
    });
  });

  // ============================================
  // handleInstancesStopped
  // ============================================

  // ============================================
  // getLatestRun
  // ============================================

  describe('getLatestRun', () => {
    it('should return null when no runs exist', async () => {
      mockPrisma.run.findFirst.mockResolvedValue(null);

      const result = await service.getLatestRun();

      expect(result).toBeNull();
    });

    it('should return the latest run with instance details', async () => {
      mockPrisma.run.findFirst.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.COMPLETED,
        createdAt: new Date('2026-01-01'),
        completedAt: new Date('2026-01-01T00:05:00'),
        instances: [
          {
            id: 'inst-1',
            name: 'api-tests',
            status: InstanceStatus.STOPPED,
            testStatus: 'PASSED',
            errorMessage: null,
          },
        ],
      });

      const result = await service.getLatestRun();

      expect(result!.runId).toBe('run-1');
      expect(result!.status).toBe(RunStatus.COMPLETED);
      expect(result!.instances).toHaveLength(1);
      expect(result!.instances[0]).toEqual({
        id: 'inst-1',
        name: 'api-tests',
        status: InstanceStatus.STOPPED,
        testStatus: 'PASSED',
        errorMessage: null,
      });
    });

    it('should filter by projectPath when provided', async () => {
      mockPrisma.run.findFirst.mockResolvedValue(null);

      await service.getLatestRun('/home/user/my-project');

      expect(mockPrisma.run.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { projectPath: '/home/user/my-project' },
        }),
      );
    });

    it('should not filter by projectPath when omitted', async () => {
      mockPrisma.run.findFirst.mockResolvedValue(null);

      await service.getLatestRun();

      expect(mockPrisma.run.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: undefined,
        }),
      );
    });
  });

  // ============================================
  // getRunHistory
  // ============================================

  describe('getRunHistory', () => {
    it('should return empty array when no runs exist', async () => {
      mockPrisma.run.findMany.mockResolvedValue([]);

      const result = await service.getRunHistory();

      expect(result).toEqual([]);
    });

    it('should return runs with instance details', async () => {
      mockPrisma.run.findMany.mockResolvedValue([
        {
          id: 'run-2',
          status: RunStatus.COMPLETED,
          createdAt: new Date('2026-01-02'),
          completedAt: new Date('2026-01-02T00:05:00'),
          instances: [
            {
              id: 'inst-2',
              name: 'api-tests',
              status: InstanceStatus.STOPPED,
              testStatus: 'PASSED',
              errorMessage: null,
            },
          ],
        },
        {
          id: 'run-1',
          status: RunStatus.FAILED,
          createdAt: new Date('2026-01-01'),
          completedAt: new Date('2026-01-01T00:05:00'),
          instances: [
            {
              id: 'inst-1',
              name: 'api-tests',
              status: InstanceStatus.STOPPED,
              testStatus: 'FAILED',
              errorMessage: 'assertion failed',
            },
          ],
        },
      ]);

      const result = await service.getRunHistory();

      expect(result).toHaveLength(2);
      expect(result[0].runId).toBe('run-2');
      expect(result[0].status).toBe(RunStatus.COMPLETED);
      expect(result[1].runId).toBe('run-1');
      expect(result[1].instances[0].errorMessage).toBe('assertion failed');
    });

    it('should filter by projectPath when provided', async () => {
      mockPrisma.run.findMany.mockResolvedValue([]);

      await service.getRunHistory('/my/project');

      expect(mockPrisma.run.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { projectPath: '/my/project' },
        }),
      );
    });

    it('should respect the limit parameter', async () => {
      mockPrisma.run.findMany.mockResolvedValue([]);

      await service.getRunHistory(undefined, 5);

      expect(mockPrisma.run.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 5,
        }),
      );
    });

    it('should default limit to 10', async () => {
      mockPrisma.run.findMany.mockResolvedValue([]);

      await service.getRunHistory();

      expect(mockPrisma.run.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 10,
        }),
      );
    });
  });

  // ============================================
  // deleteRun
  // ============================================

  describe('deleteRun', () => {
    it('should throw if run not found', async () => {
      mockPrisma.run.findUnique.mockResolvedValue(null);

      await expect(service.deleteRun('bad-run')).rejects.toThrow(
        'Run bad-run not found',
      );
    });

    it('should stop instances, delete run, clean storage, and delete secret', async () => {
      const createdAt = new Date('2026-01-01');
      const projectPath = '/my/project';
      const instances = [
        { id: 'inst-1', status: InstanceStatus.RUNNING },
        { id: 'inst-2', status: InstanceStatus.STOPPED },
      ];
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        projectPath,
        createdAt,
        instances,
      });

      const result = await service.deleteRun('run-1');

      expect(mockCleanup.stopInstances).toHaveBeenCalledWith(instances);
      expect(mockPrisma.run.delete).toHaveBeenCalledWith({
        where: { id: 'run-1' },
      });
      expect(mockRunStorage.deleteRunDir).toHaveBeenCalledWith(
        projectPath,
        createdAt,
      );
      expect(mockRegistryService.clearCredentials).toHaveBeenCalledWith(
        'run-1',
      );
      expect(result).toEqual({ runId: 'run-1', status: 'DELETED' });
    });

    it('should clear registry credentials on delete', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        projectPath: '/my/project',
        createdAt: new Date('2026-01-01'),
        instances: [],
      });

      const result = await service.deleteRun('run-1');

      expect(mockRegistryService.clearCredentials).toHaveBeenCalledWith(
        'run-1',
      );
      expect(result.status).toBe('DELETED');
    });
  });

  // ============================================
  // getRunStatus - scheduler trigger
  // ============================================

  describe('getRunStatus', () => {
    it('should trigger scheduler for RUNNING runs', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.RUNNING,
        createdAt: new Date(),
        completedAt: null,
        cancelledAt: null,
        instances: [],
      });

      await service.getRunStatus('run-1');

      expect(mockScheduler.deployPendingInstances).toHaveBeenCalledWith(
        'run-1',
      );
    });

    it('should trigger scheduler for PENDING runs', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.PENDING,
        createdAt: new Date(),
        completedAt: null,
        cancelledAt: null,
        instances: [],
      });

      await service.getRunStatus('run-1');

      expect(mockScheduler.deployPendingInstances).toHaveBeenCalledWith(
        'run-1',
      );
    });

    it('should not trigger scheduler for COMPLETED runs', async () => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.COMPLETED,
        createdAt: new Date(),
        completedAt: new Date(),
        cancelledAt: null,
        instances: [],
      });

      await service.getRunStatus('run-1');

      expect(mockScheduler.deployPendingInstances).not.toHaveBeenCalled();
    });
  });

  // ============================================
  // submitInstance telemetry
  // ============================================

  describe('submitInstance telemetry', () => {
    beforeEach(() => {
      mockPrisma.run.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RunStatus.RUNNING,
      });
      mockPrisma.namespaceInstance.findUnique.mockResolvedValue({
        id: 'inst-1',
        runId: 'run-1',
        status: InstanceStatus.PENDING,
      });
      mockPrisma.instanceItem.create.mockResolvedValue({ id: 'item-1' });
    });

    it('should track telemetry with item types and test counts', async () => {
      const dto: SubmitInstanceDto = {
        definition: {
          name: 'test',
          items: [
            { name: 'api', type: 'SERVICE', image: 'x:1', port: 80 },
            { name: 'db', type: 'DATABASE', database: 'postgres' },
            { name: 'mock-svc', type: 'MOCK', port: 9090 },
          ],
          tests: [
            {
              name: 'test-1',
              steps: [
                { action: { type: 'httpCall' } },
                { action: { type: 'httpCall' }, extract: { var1: '$.body' } },
              ],
            },
          ],
        },
      };

      await service.submitInstance('run-1', 'inst-1', dto);

      expect(mockTelemetry.track).toHaveBeenCalledWith(
        'ct_instance_submitted',
        expect.objectContaining({
          item_count: 3,
          item_types: { service: 1, database: 1, mock: 1 },
          has_tests: true,
          test_count: 1,
          total_step_count: 2,
          has_extract: true,
        }),
      );
    });

    it('should handle definition with no tests', async () => {
      const dto: SubmitInstanceDto = {
        definition: {
          name: 'test',
          items: [{ name: 'api', type: 'SERVICE', image: 'x:1', port: 80 }],
        },
      };

      await service.submitInstance('run-1', 'inst-1', dto);

      expect(mockTelemetry.track).toHaveBeenCalledWith(
        'ct_instance_submitted',
        expect.objectContaining({
          has_tests: false,
          test_count: 0,
          total_step_count: 0,
          has_extract: false,
        }),
      );
    });
  });

  // ============================================
  // handleInstancesStopped
  // ============================================

  describe('handleInstancesStopped', () => {
    it('should delegate to scheduler', async () => {
      await service.handleInstancesStopped(['run-1', 'run-2']);

      expect(mockScheduler.handleInstancesStopped).toHaveBeenCalledWith([
        'run-1',
        'run-2',
      ]);
    });
  });

  // ============================================
  // onApplicationBootstrap
  // ============================================

  describe('onApplicationBootstrap', () => {
    it('should call cleanup.recoverOrphanedRuns', async () => {
      await service.onApplicationBootstrap();

      expect(mockCleanup.recoverOrphanedRuns).toHaveBeenCalled();
    });

    it('should not throw if recoverOrphanedRuns fails', async () => {
      mockCleanup.recoverOrphanedRuns.mockRejectedValue(new Error('DB down'));

      await expect(service.onApplicationBootstrap()).resolves.not.toThrow();
    });
  });
});
