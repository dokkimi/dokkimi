import { RunsController } from './runs.controller';

describe('RunsController', () => {
  let controller: RunsController;

  const mockRunsService: any = {
    createRun: jest.fn(),
    submitInstance: jest.fn(),
    getLatestRun: jest.fn(),
    getRunStatus: jest.fn(),
    stopCurrentRun: jest.fn(),
    deleteRun: jest.fn(),
    ensureInstanceRegistered: jest.fn().mockResolvedValue(undefined),
  };

  const mockRunStorage: any = {
    readDefinition: jest.fn(),
  };

  beforeEach(() => {
    controller = new RunsController(mockRunsService, mockRunStorage);
    jest.clearAllMocks();
  });

  describe('createRun', () => {
    it('delegates to runsService.createRun with definitions', async () => {
      const dto = { definitions: ['api-tests', 'db-tests'] };
      const expected = { runId: 'run-1', instances: [] };
      mockRunsService.createRun.mockResolvedValue(expected);

      const result = await controller.createRun(dto as any);

      expect(mockRunsService.createRun).toHaveBeenCalledWith(
        ['api-tests', 'db-tests'],
        undefined,
        undefined,
      );
      expect(result).toEqual(expected);
    });

    it('passes registryCredentials when provided', async () => {
      const creds = [{ registryUrl: 'ghcr.io', username: 'u', password: 'p' }];
      const dto = { definitions: ['test'], registryCredentials: creds };
      mockRunsService.createRun.mockResolvedValue({ runId: 'run-1' });

      await controller.createRun(dto as any);

      expect(mockRunsService.createRun).toHaveBeenCalledWith(
        ['test'],
        creds,
        undefined,
      );
    });

    it('passes projectPath when provided', async () => {
      const dto = {
        definitions: ['test'],
        projectPath: '/home/user/my-project',
      };
      mockRunsService.createRun.mockResolvedValue({ runId: 'run-1' });

      await controller.createRun(dto as any);

      expect(mockRunsService.createRun).toHaveBeenCalledWith(
        ['test'],
        undefined,
        '/home/user/my-project',
      );
    });
  });

  describe('submitInstance', () => {
    it('delegates to runsService.submitInstance', async () => {
      const dto = { definition: { name: 'test', items: [] } };
      const expected = { instanceId: 'inst-1', status: 'PENDING' };
      mockRunsService.submitInstance.mockResolvedValue(expected);

      const result = await controller.submitInstance(
        'run-1',
        'inst-1',
        dto as any,
      );

      expect(mockRunsService.submitInstance).toHaveBeenCalledWith(
        'run-1',
        'inst-1',
        dto,
      );
      expect(result).toEqual(expected);
    });
  });

  describe('getLatestRun', () => {
    it('delegates to runsService.getLatestRun', async () => {
      const expected = { runId: 'run-1', status: 'COMPLETED' };
      mockRunsService.getLatestRun.mockResolvedValue(expected);

      const result = await controller.getLatestRun();

      expect(mockRunsService.getLatestRun).toHaveBeenCalledWith(undefined);
      expect(result).toEqual(expected);
    });

    it('returns null when no runs exist', async () => {
      mockRunsService.getLatestRun.mockResolvedValue(null);

      const result = await controller.getLatestRun();

      expect(result).toBeNull();
    });

    it('passes projectPath to runsService when provided', async () => {
      const expected = { runId: 'run-1', status: 'COMPLETED' };
      mockRunsService.getLatestRun.mockResolvedValue(expected);

      const result = await controller.getLatestRun('/home/user/my-project');

      expect(mockRunsService.getLatestRun).toHaveBeenCalledWith(
        '/home/user/my-project',
      );
      expect(result).toEqual(expected);
    });
  });

  describe('getRunStatus', () => {
    it('delegates to runsService.getRunStatus with runId', async () => {
      const expected = { runId: 'run-1', status: 'RUNNING', instances: [] };
      mockRunsService.getRunStatus.mockResolvedValue(expected);

      const result = await controller.getRunStatus('run-1');

      expect(mockRunsService.getRunStatus).toHaveBeenCalledWith('run-1');
      expect(result).toEqual(expected);
    });
  });

  describe('stopCurrentRun', () => {
    it('delegates to runsService.stopCurrentRun', async () => {
      const expected = { runId: 'run-1', status: 'CANCELLED' };
      mockRunsService.stopCurrentRun.mockResolvedValue(expected);

      const result = await controller.stopCurrentRun();

      expect(mockRunsService.stopCurrentRun).toHaveBeenCalled();
      expect(result).toEqual(expected);
    });
  });

  describe('deleteRun', () => {
    it('delegates to runsService.deleteRun with runId', async () => {
      const expected = { runId: 'run-1', status: 'DELETED' };
      mockRunsService.deleteRun.mockResolvedValue(expected);

      const result = await controller.deleteRun('run-1');

      expect(mockRunsService.deleteRun).toHaveBeenCalledWith('run-1');
      expect(result).toEqual(expected);
    });
  });

  describe('getInstanceDefinition', () => {
    it('delegates to runStorage.readDefinition with instanceId', async () => {
      const expected = { name: 'test', items: [] };
      mockRunStorage.readDefinition.mockResolvedValue(expected);

      const result = await controller.getInstanceDefinition('run-1', 'inst-1');

      expect(mockRunsService.ensureInstanceRegistered).toHaveBeenCalledWith(
        'run-1',
        'inst-1',
      );
      expect(mockRunStorage.readDefinition).toHaveBeenCalledWith('inst-1');
      expect(result).toEqual(expected);
    });
  });
});
