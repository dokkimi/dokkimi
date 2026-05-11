import { InstanceStatus, ItemStatus } from '@prisma/client';
import { WatcherService } from './watcher.service';

jest.mock('../namespace-lifecycle/kubernetes/kubeconfig-loader', () => ({
  loadKubeConfig: () => ({
    makeApiClient: () => mockK8sApi,
  }),
}));

const mockK8sApi = {
  listNamespacedPod: jest.fn(),
};

describe('WatcherService', () => {
  let service: WatcherService;

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === 'IDLE_POLL_INTERVAL_MS') {
        return 5000;
      }
      if (key === 'ACTIVE_POLL_INTERVAL_MS') {
        return 1000;
      }
      return undefined;
    }),
  };

  const mockPrisma = {
    namespaceInstance: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
    instanceItem: {
      updateMany: jest.fn(),
    },
  };

  const mockLogger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  };

  const mockTelemetry = {
    track: jest.fn(),
  };

  const mockRunsService = {
    handleInstancesStopped: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    service = new WatcherService(
      mockConfigService as any,
      mockPrisma as any,
      mockLogger as any,
      mockTelemetry as any,
      mockRunsService as any,
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  async function triggerPoll() {
    await service.onModuleInit();
    await jest.advanceTimersByTimeAsync(5000);
  }

  describe('onModuleInit / onModuleDestroy', () => {
    it('should start polling on init', async () => {
      mockPrisma.namespaceInstance.findMany.mockResolvedValue([]);
      await triggerPoll();
      expect(mockPrisma.namespaceInstance.findMany).toHaveBeenCalled();
    });

    it('should stop polling on destroy', async () => {
      mockPrisma.namespaceInstance.findMany.mockResolvedValue([]);
      await service.onModuleInit();
      service.onModuleDestroy();
      jest.clearAllMocks();
      await jest.advanceTimersByTimeAsync(10000);
      expect(mockPrisma.namespaceInstance.findMany).not.toHaveBeenCalled();
    });
  });

  describe('pollTerminatingNamespaces', () => {
    it('should schedule idle poll when no terminating instances exist', async () => {
      mockPrisma.namespaceInstance.findMany.mockResolvedValue([]);
      await triggerPoll();

      expect(mockK8sApi.listNamespacedPod).not.toHaveBeenCalled();

      // Next poll should be at idle interval
      jest.clearAllMocks();
      mockPrisma.namespaceInstance.findMany.mockResolvedValue([]);
      await jest.advanceTimersByTimeAsync(5000);
      expect(mockPrisma.namespaceInstance.findMany).toHaveBeenCalled();
    });

    it('should mark instance STOPPED when namespace has 0 pods', async () => {
      mockPrisma.namespaceInstance.findMany.mockResolvedValue([
        { id: 'inst-1', runId: 'run-1' },
      ]);
      mockK8sApi.listNamespacedPod.mockResolvedValue({ items: [] });
      mockPrisma.namespaceInstance.update.mockResolvedValue({});
      mockPrisma.instanceItem.updateMany.mockResolvedValue({});
      mockRunsService.handleInstancesStopped.mockResolvedValue(undefined);

      await triggerPoll();

      expect(mockPrisma.namespaceInstance.update).toHaveBeenCalledWith({
        where: { id: 'inst-1' },
        data: {
          status: InstanceStatus.STOPPED,
          stoppedAt: expect.any(Date),
        },
      });
      expect(mockPrisma.instanceItem.updateMany).toHaveBeenCalledWith({
        where: { instanceId: 'inst-1' },
        data: { status: ItemStatus.STOPPED },
      });
    });

    it('should NOT mark instance stopped when pods still exist', async () => {
      mockPrisma.namespaceInstance.findMany.mockResolvedValue([
        { id: 'inst-1', runId: 'run-1' },
      ]);
      mockK8sApi.listNamespacedPod.mockResolvedValue({
        items: [{ metadata: { name: 'pod-1' } }],
      });

      await triggerPoll();

      expect(mockPrisma.namespaceInstance.update).not.toHaveBeenCalled();
    });

    it('should mark instance STOPPED when namespace returns 404', async () => {
      mockPrisma.namespaceInstance.findMany.mockResolvedValue([
        { id: 'inst-1', runId: 'run-1' },
      ]);
      mockK8sApi.listNamespacedPod.mockRejectedValue({
        response: { statusCode: 404 },
      });
      mockPrisma.namespaceInstance.update.mockResolvedValue({});
      mockPrisma.instanceItem.updateMany.mockResolvedValue({});
      mockRunsService.handleInstancesStopped.mockResolvedValue(undefined);

      await triggerPoll();

      expect(mockPrisma.namespaceInstance.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: InstanceStatus.STOPPED,
          }),
        }),
      );
    });

    it('should handle 404 via error code property', async () => {
      mockPrisma.namespaceInstance.findMany.mockResolvedValue([
        { id: 'inst-1', runId: 'run-1' },
      ]);
      mockK8sApi.listNamespacedPod.mockRejectedValue({ code: 404 });
      mockPrisma.namespaceInstance.update.mockResolvedValue({});
      mockPrisma.instanceItem.updateMany.mockResolvedValue({});
      mockRunsService.handleInstancesStopped.mockResolvedValue(undefined);

      await triggerPoll();

      expect(mockPrisma.namespaceInstance.update).toHaveBeenCalled();
    });

    it('should log error and not mark stopped on non-404 K8s error', async () => {
      mockPrisma.namespaceInstance.findMany.mockResolvedValue([
        { id: 'inst-1', runId: 'run-1' },
      ]);
      mockK8sApi.listNamespacedPod.mockRejectedValue({
        response: { statusCode: 500 },
      });

      await triggerPoll();

      expect(mockPrisma.namespaceInstance.update).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error checking namespace'),
      );
    });

    it('should notify runs service with unique run IDs for stopped instances', async () => {
      mockPrisma.namespaceInstance.findMany.mockResolvedValue([
        { id: 'inst-1', runId: 'run-1' },
        { id: 'inst-2', runId: 'run-1' },
        { id: 'inst-3', runId: 'run-2' },
      ]);
      mockK8sApi.listNamespacedPod.mockResolvedValue({ items: [] });
      mockPrisma.namespaceInstance.update.mockResolvedValue({});
      mockPrisma.instanceItem.updateMany.mockResolvedValue({});
      mockRunsService.handleInstancesStopped.mockResolvedValue(undefined);

      await triggerPoll();

      expect(mockRunsService.handleInstancesStopped).toHaveBeenCalledWith(
        expect.arrayContaining(['run-1', 'run-2']),
      );
      const callArgs = mockRunsService.handleInstancesStopped.mock.calls[0][0];
      expect(callArgs).toHaveLength(2);
    });

    it('should not notify runs service when no instances were stopped', async () => {
      mockPrisma.namespaceInstance.findMany.mockResolvedValue([
        { id: 'inst-1', runId: 'run-1' },
      ]);
      mockK8sApi.listNamespacedPod.mockResolvedValue({
        items: [{ metadata: { name: 'pod-1' } }],
      });

      await triggerPoll();

      expect(mockRunsService.handleInstancesStopped).not.toHaveBeenCalled();
    });

    it('should catch and log errors from notifyRunsService', async () => {
      mockPrisma.namespaceInstance.findMany.mockResolvedValue([
        { id: 'inst-1', runId: 'run-1' },
      ]);
      mockK8sApi.listNamespacedPod.mockResolvedValue({ items: [] });
      mockPrisma.namespaceInstance.update.mockResolvedValue({});
      mockPrisma.instanceItem.updateMany.mockResolvedValue({});
      mockRunsService.handleInstancesStopped.mockRejectedValue(
        new Error('runs service down'),
      );

      await triggerPoll();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to notify runs service'),
      );
      expect(mockTelemetry.track).toHaveBeenCalledWith(
        'cws_notify_runs_failed',
        { module: 'cluster-watcher' },
      );
    });

    it('should catch and log errors from markInstanceStopped', async () => {
      mockPrisma.namespaceInstance.findMany.mockResolvedValue([
        { id: 'inst-1', runId: 'run-1' },
      ]);
      mockK8sApi.listNamespacedPod.mockResolvedValue({ items: [] });
      mockPrisma.namespaceInstance.update.mockRejectedValue(
        new Error('db error'),
      );

      await triggerPoll();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to mark instance'),
      );
    });

    it('should handle the body-wrapped K8s response format', async () => {
      mockPrisma.namespaceInstance.findMany.mockResolvedValue([
        { id: 'inst-1', runId: 'run-1' },
      ]);
      mockK8sApi.listNamespacedPod.mockResolvedValue({
        body: { items: [] },
      });
      mockPrisma.namespaceInstance.update.mockResolvedValue({});
      mockPrisma.instanceItem.updateMany.mockResolvedValue({});
      mockRunsService.handleInstancesStopped.mockResolvedValue(undefined);

      await triggerPoll();

      expect(mockPrisma.namespaceInstance.update).toHaveBeenCalled();
    });

    it('should continue polling after an error in the main poll loop', async () => {
      mockPrisma.namespaceInstance.findMany.mockRejectedValueOnce(
        new Error('transient DB error'),
      );
      await triggerPoll();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error polling'),
      );

      // Should schedule next poll at idle interval — verify it still polls
      jest.clearAllMocks();
      mockPrisma.namespaceInstance.findMany.mockResolvedValue([]);
      await jest.advanceTimersByTimeAsync(5000);
      expect(mockPrisma.namespaceInstance.findMany).toHaveBeenCalled();
    });

    it('should use active poll interval when terminating instances exist', async () => {
      mockPrisma.namespaceInstance.findMany.mockResolvedValue([
        { id: 'inst-1', runId: 'run-1' },
      ]);
      mockK8sApi.listNamespacedPod.mockResolvedValue({
        items: [{ metadata: { name: 'still-running' } }],
      });

      await triggerPoll();

      // Next poll should be at active interval (1000ms)
      jest.clearAllMocks();
      mockPrisma.namespaceInstance.findMany.mockResolvedValue([]);
      await jest.advanceTimersByTimeAsync(1000);
      expect(mockPrisma.namespaceInstance.findMany).toHaveBeenCalled();
    });
  });
});
