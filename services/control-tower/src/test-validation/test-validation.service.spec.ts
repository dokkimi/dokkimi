import { TestValidationService } from './test-validation.service';
import { TestStatus } from '@prisma/client';

describe('TestValidationService', () => {
  let service: TestValidationService;

  const mockPrismaService: any = {
    namespaceInstance: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    testExecutionLog: {
      create: jest.fn(),
    },
    assertionResult: {
      create: jest.fn(),
    },
  };

  const mockRunsService: any = {
    handleValidationComplete: jest.fn().mockResolvedValue(undefined),
  };

  const mockRunStorage: any = {
    readDefinition: jest.fn(),
  };

  const mockStepValidator: any = {
    validateTestAssertions: jest.fn(),
  };

  const mockQuiescenceDetection: any = {
    waitForLogsToSettle: jest.fn().mockResolvedValue(undefined),
  };

  const mockLoopDetection: any = {
    detectLoops: jest.fn(),
  };

  const mockLogger: any = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  };

  const mockTelemetry: any = {
    track: jest.fn(),
  };

  const mockVisualMatch: any = {
    processInstance: jest.fn().mockResolvedValue({ failures: [] }),
  };

  beforeEach(() => {
    service = new TestValidationService(
      mockLogger,
      mockPrismaService,
      mockRunsService,
      mockRunStorage,
      mockStepValidator,
      mockQuiescenceDetection,
      mockLoopDetection,
      mockTelemetry,
      mockVisualMatch,
    );

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('processTestCompletion', () => {
    const testRunId = 'instance-123';

    const mockInstance = {
      id: testRunId,
      name: 'test-instance',
      status: 'RUNNING',
    };

    it('should process successful test completion with no test steps', async () => {
      mockPrismaService.namespaceInstance.findUnique.mockResolvedValue(
        mockInstance as any,
      );
      mockPrismaService.namespaceInstance.update.mockResolvedValue(
        mockInstance as any,
      );
      mockRunStorage.readDefinition.mockResolvedValue({ tests: [] });
      mockQuiescenceDetection.waitForLogsToSettle.mockResolvedValue(undefined);
      mockRunsService.handleValidationComplete.mockResolvedValue(undefined);

      await service.processTestCompletion(testRunId, 'success', 'Tests passed');

      expect(
        mockPrismaService.namespaceInstance.findUnique,
      ).toHaveBeenCalledWith({
        where: { id: testRunId },
      });

      expect(mockPrismaService.namespaceInstance.update).toHaveBeenCalledWith({
        where: { id: testRunId },
        data: {
          testStatus: TestStatus.PASSED,
          testResults: null,
          testCompletedAt: expect.any(Date),
          errorMessage: null,
        },
      });

      expect(mockRunsService.handleValidationComplete).toHaveBeenCalledWith(
        testRunId,
        true,
        undefined,
      );
    });

    it('should process failed test completion', async () => {
      mockPrismaService.namespaceInstance.findUnique.mockResolvedValue(
        mockInstance as any,
      );
      mockPrismaService.namespaceInstance.update.mockResolvedValue(
        mockInstance as any,
      );
      mockRunsService.handleValidationComplete.mockResolvedValue(undefined);

      await service.processTestCompletion(
        testRunId,
        'failure',
        'Test execution failed',
      );

      expect(mockPrismaService.namespaceInstance.update).toHaveBeenCalledWith({
        where: { id: testRunId },
        data: {
          testStatus: TestStatus.FAILED,
          testResults: null,
          testCompletedAt: expect.any(Date),
          errorMessage: 'Test execution failed',
        },
      });

      expect(mockRunsService.handleValidationComplete).toHaveBeenCalledWith(
        testRunId,
        false,
        'Test execution failed',
      );
    });

    it('should use default error message when not provided for failure', async () => {
      mockPrismaService.namespaceInstance.findUnique.mockResolvedValue(
        mockInstance as any,
      );
      mockPrismaService.namespaceInstance.update.mockResolvedValue(
        mockInstance as any,
      );
      mockRunsService.handleValidationComplete.mockResolvedValue(undefined);

      await service.processTestCompletion(testRunId, 'failure');

      expect(mockPrismaService.namespaceInstance.update).toHaveBeenCalledWith({
        where: { id: testRunId },
        data: {
          testStatus: TestStatus.FAILED,
          testResults: null,
          testCompletedAt: expect.any(Date),
          errorMessage: 'Test execution failed',
        },
      });
    });

    it('should throw error if instance not found', async () => {
      mockPrismaService.namespaceInstance.findUnique.mockResolvedValue(null);

      await expect(
        service.processTestCompletion(testRunId, 'success'),
      ).rejects.toThrow(`Instance not found for testRunId ${testRunId}`);

      expect(mockPrismaService.namespaceInstance.update).not.toHaveBeenCalled();
      expect(mockRunsService.handleValidationComplete).not.toHaveBeenCalled();
    });

    it('should handle CT notification failure gracefully', async () => {
      mockPrismaService.namespaceInstance.findUnique.mockResolvedValue(
        mockInstance as any,
      );
      mockPrismaService.namespaceInstance.update.mockResolvedValue(
        mockInstance as any,
      );
      mockRunStorage.readDefinition.mockResolvedValue({ tests: [] });
      mockQuiescenceDetection.waitForLogsToSettle.mockResolvedValue(undefined);
      mockRunsService.handleValidationComplete.mockResolvedValue(undefined);

      // Should not throw even if CT notification is called
      await service.processTestCompletion(testRunId, 'success');

      expect(mockPrismaService.namespaceInstance.update).toHaveBeenCalled();
      expect(mockRunsService.handleValidationComplete).toHaveBeenCalled();
    });

    it('should read test definitions from run storage', async () => {
      mockPrismaService.namespaceInstance.findUnique.mockResolvedValue(
        mockInstance as any,
      );
      mockPrismaService.namespaceInstance.update.mockResolvedValue(
        mockInstance as any,
      );
      mockRunStorage.readDefinition.mockResolvedValue({
        tests: [{ name: 'test', steps: [] }],
      });
      mockQuiescenceDetection.waitForLogsToSettle.mockResolvedValue(undefined);
      mockRunsService.handleValidationComplete.mockResolvedValue(undefined);

      await service.processTestCompletion(testRunId, 'success');

      expect(mockRunStorage.readDefinition).toHaveBeenCalledWith(testRunId);
    });

    it('should handle run storage read failure gracefully', async () => {
      mockPrismaService.namespaceInstance.findUnique.mockResolvedValue(
        mockInstance as any,
      );
      mockPrismaService.namespaceInstance.update.mockResolvedValue(
        mockInstance as any,
      );
      mockRunStorage.readDefinition.mockRejectedValue(
        new Error('File not found'),
      );
      mockQuiescenceDetection.waitForLogsToSettle.mockResolvedValue(undefined);
      mockRunsService.handleValidationComplete.mockResolvedValue(undefined);

      // Should not throw — falls back to "no tests" path
      await service.processTestCompletion(testRunId, 'success');

      expect(mockPrismaService.namespaceInstance.update).toHaveBeenCalled();
    });
  });

  describe('success path — with tests', () => {
    const testRunId = 'instance-tests';
    const mockInstance = {
      id: testRunId,
      name: 'test-inst',
      status: 'RUNNING',
    };

    beforeEach(() => {
      mockPrismaService.namespaceInstance.findUnique.mockResolvedValue(
        mockInstance as any,
      );
      mockPrismaService.namespaceInstance.update.mockResolvedValue(
        mockInstance as any,
      );
      mockRunsService.handleValidationComplete.mockResolvedValue(undefined);
      mockRunStorage.readDefinition.mockResolvedValue({
        tests: [{ name: 'test-1', steps: [{ action: { type: 'httpCall' } }] }],
      });
      mockQuiescenceDetection.waitForLogsToSettle.mockResolvedValue(undefined);
      mockVisualMatch.processInstance.mockResolvedValue({ failures: [] });
    });

    it('calls quiescence detection before validation', async () => {
      mockStepValidator.validateTestAssertions.mockResolvedValue({
        passed: true,
        telemetry: {},
      });
      mockLoopDetection.detectLoops.mockResolvedValue({ hasLoop: false });

      const executions = [
        {
          stepIndex: 0,
          startTime: '2026-01-01T00:00:01Z',
          endTime: '2026-01-01T00:00:02Z',
        },
      ];
      await service.processTestCompletion(
        testRunId,
        'success',
        undefined,
        executions,
      );

      expect(mockQuiescenceDetection.waitForLogsToSettle).toHaveBeenCalled();
    });

    it('throws if stepExecutions is missing', async () => {
      mockStepValidator.validateTestAssertions.mockResolvedValue({
        passed: true,
      });

      await service.processTestCompletion(testRunId, 'success');

      expect(mockPrismaService.namespaceInstance.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ testStatus: TestStatus.FAILED }),
        }),
      );
    });

    it('marks PASSED when validation passes and no loops', async () => {
      mockStepValidator.validateTestAssertions.mockResolvedValue({
        passed: true,
        telemetry: {},
      });
      mockLoopDetection.detectLoops.mockResolvedValue({ hasLoop: false });

      const executions = [
        {
          stepIndex: 0,
          startTime: '2026-01-01T00:00:01Z',
          endTime: '2026-01-01T00:00:02Z',
        },
      ];
      await service.processTestCompletion(
        testRunId,
        'success',
        undefined,
        executions,
      );

      expect(mockPrismaService.namespaceInstance.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ testStatus: TestStatus.PASSED }),
        }),
      );
    });

    it('marks FAILED when validation fails', async () => {
      mockStepValidator.validateTestAssertions.mockResolvedValue({
        passed: false,
        error: 'assertion mismatch',
        telemetry: {},
      });
      mockLoopDetection.detectLoops.mockResolvedValue({ hasLoop: false });

      const executions = [
        {
          stepIndex: 0,
          startTime: '2026-01-01T00:00:01Z',
          endTime: '2026-01-01T00:00:02Z',
        },
      ];
      await service.processTestCompletion(
        testRunId,
        'success',
        undefined,
        executions,
      );

      expect(mockPrismaService.namespaceInstance.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            testStatus: TestStatus.FAILED,
            errorMessage: 'assertion mismatch',
          }),
        }),
      );
    });

    it('marks FAILED when loop detected even if validation passed', async () => {
      mockStepValidator.validateTestAssertions.mockResolvedValue({
        passed: true,
        telemetry: {},
      });
      mockLoopDetection.detectLoops.mockResolvedValue({
        hasLoop: true,
        reason: 'api→db called 100 times',
      });

      const executions = [
        {
          stepIndex: 0,
          startTime: '2026-01-01T00:00:01Z',
          endTime: '2026-01-01T00:00:02Z',
        },
      ];
      await service.processTestCompletion(
        testRunId,
        'success',
        undefined,
        executions,
      );

      expect(mockPrismaService.namespaceInstance.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            testStatus: TestStatus.FAILED,
            errorMessage: expect.stringContaining('Infinite loop detected'),
          }),
        }),
      );
      expect(mockTelemetry.track).toHaveBeenCalledWith(
        'tvs_loop_detected',
        expect.any(Object),
      );
    });

    it('delegates to stepValidator.validateTestAssertions', async () => {
      mockStepValidator.validateTestAssertions.mockResolvedValue({
        passed: true,
        telemetry: {},
      });
      mockLoopDetection.detectLoops.mockResolvedValue({ hasLoop: false });

      const executions = [
        {
          stepIndex: 0,
          startTime: '2026-01-01T00:00:01Z',
          endTime: '2026-01-01T00:00:02Z',
        },
      ];
      await service.processTestCompletion(
        testRunId,
        'success',
        undefined,
        executions,
      );

      expect(mockStepValidator.validateTestAssertions).toHaveBeenCalledWith(
        testRunId,
        expect.any(Array),
        executions,
        undefined,
        undefined,
      );
    });
  });

  describe('failure path — with steps', () => {
    const testRunId = 'instance-fail';
    const mockInstance = {
      id: testRunId,
      name: 'fail-inst',
      status: 'RUNNING',
    };

    it('writes SKIPPED for unexecuted steps', async () => {
      mockPrismaService.namespaceInstance.findUnique.mockResolvedValue(
        mockInstance as any,
      );
      mockPrismaService.namespaceInstance.update.mockResolvedValue(
        mockInstance as any,
      );
      mockRunsService.handleValidationComplete.mockResolvedValue(undefined);
      mockVisualMatch.processInstance.mockResolvedValue({ failures: [] });
      mockRunStorage.readDefinition.mockResolvedValue({
        tests: [
          {
            name: 'test-1',
            steps: [
              { action: { type: 'httpCall' } },
              { action: { type: 'httpCall' } },
            ],
          },
        ],
      });

      const executions = [
        {
          stepIndex: 0,
          startTime: '2026-01-01T00:00:01Z',
          endTime: '2026-01-01T00:00:02Z',
        },
      ];
      await service.processTestCompletion(
        testRunId,
        'failure',
        'step 1 failed',
        executions,
      );

      expect(mockPrismaService.assertionResult.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          stepIndex: 1,
          resultKind: 'SKIPPED',
        }),
      });
    });
  });

  describe('runs service notification', () => {
    const testRunId = 'instance-notify';
    const mockInstance = {
      id: testRunId,
      name: 'notify-inst',
      status: 'RUNNING',
    };

    beforeEach(() => {
      mockPrismaService.namespaceInstance.findUnique.mockResolvedValue(
        mockInstance as any,
      );
      mockPrismaService.namespaceInstance.update.mockResolvedValue(
        mockInstance as any,
      );
      mockRunStorage.readDefinition.mockResolvedValue({ tests: [] });
      mockQuiescenceDetection.waitForLogsToSettle.mockResolvedValue(undefined);
      mockVisualMatch.processInstance.mockResolvedValue({ failures: [] });
    });

    it('does not throw if handleValidationComplete fails', async () => {
      mockRunsService.handleValidationComplete.mockRejectedValue(
        new Error('runs service down'),
      );

      await expect(
        service.processTestCompletion(testRunId, 'success'),
      ).resolves.not.toThrow();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to notify runs service'),
        expect.any(String),
      );
    });
  });

  describe('telemetry', () => {
    const testRunId = 'instance-telem';
    const mockInstance = {
      id: testRunId,
      name: 'telem-inst',
      status: 'RUNNING',
    };

    beforeEach(() => {
      mockPrismaService.namespaceInstance.findUnique.mockResolvedValue(
        mockInstance as any,
      );
      mockPrismaService.namespaceInstance.update.mockResolvedValue(
        mockInstance as any,
      );
      mockRunsService.handleValidationComplete.mockResolvedValue(undefined);
      mockVisualMatch.processInstance.mockResolvedValue({ failures: [] });
    });

    it('tracks tvs_validation_completed with variables flag', async () => {
      mockRunStorage.readDefinition.mockResolvedValue({
        tests: [],
        variables: { key: 'val' },
      });
      mockQuiescenceDetection.waitForLogsToSettle.mockResolvedValue(undefined);

      await service.processTestCompletion(testRunId, 'success');

      expect(mockTelemetry.track).toHaveBeenCalledWith(
        'tvs_validation_completed',
        expect.objectContaining({
          has_variables: true,
          result: 'PASSED',
        }),
      );
    });

    it('sets has_variables from test-level variables', async () => {
      mockRunStorage.readDefinition.mockResolvedValue({
        tests: [{ name: 'test-1', steps: [], variables: { x: 'y' } }],
      });
      mockQuiescenceDetection.waitForLogsToSettle.mockResolvedValue(undefined);

      await service.processTestCompletion(testRunId, 'success');

      expect(mockTelemetry.track).toHaveBeenCalledWith(
        'tvs_validation_completed',
        expect.objectContaining({ has_variables: true }),
      );
    });
  });

  describe('visualMatch verdict propagation', () => {
    const testRunId = 'instance-vm';
    const mockInstance = {
      id: testRunId,
      name: 'vm-instance',
      status: 'RUNNING',
    };

    beforeEach(() => {
      mockPrismaService.namespaceInstance.findUnique.mockResolvedValue(
        mockInstance as any,
      );
      mockPrismaService.namespaceInstance.update.mockResolvedValue(
        mockInstance as any,
      );
      mockRunStorage.readDefinition.mockResolvedValue({ tests: [] });
      mockQuiescenceDetection.waitForLogsToSettle.mockResolvedValue(undefined);
      mockRunsService.handleValidationComplete.mockResolvedValue(undefined);
    });

    it('does not downgrade test status when visualMatch summary is empty', async () => {
      mockVisualMatch.processInstance.mockResolvedValueOnce({ failures: [] });
      await service.processTestCompletion(testRunId, 'success', 'OK');

      expect(mockRunsService.handleValidationComplete).toHaveBeenCalledWith(
        testRunId,
        true,
        undefined,
      );
    });

    it('downgrades a passing test to FAILED when visualMatch reports a no-baseline', async () => {
      mockVisualMatch.processInstance.mockResolvedValueOnce({
        failures: [
          {
            name: 'checkout',
            verdict: 'no-baseline',
            message:
              'no baseline for "checkout" — run `dokkimi baselines approve checkout`',
          },
        ],
      });
      await service.processTestCompletion(testRunId, 'success', 'OK');

      // Status should be downgraded to FAILED with a clear visual-match error.
      const updates = mockPrismaService.namespaceInstance.update.mock.calls;
      const finalUpdate = updates[updates.length - 1][0];
      expect(finalUpdate.data.testStatus).toBe(TestStatus.FAILED);
      expect(finalUpdate.data.errorMessage).toContain('Visual match check');
      expect(finalUpdate.data.errorMessage).toContain(
        'no baseline for "checkout"',
      );

      expect(mockRunsService.handleValidationComplete).toHaveBeenCalledWith(
        testRunId,
        false,
        expect.stringContaining('no baseline for "checkout"'),
      );
    });

    it('downgrades a passing test to FAILED when visualMatch reports a fail verdict', async () => {
      mockVisualMatch.processInstance.mockResolvedValueOnce({
        failures: [
          {
            name: 'cart',
            verdict: 'fail',
            message:
              'visual diff exceeded threshold for "cart" — review diff/cart.png',
          },
        ],
      });
      await service.processTestCompletion(testRunId, 'success', 'OK');

      expect(mockRunsService.handleValidationComplete).toHaveBeenCalledWith(
        testRunId,
        false,
        expect.stringContaining('visual diff exceeded threshold for "cart"'),
      );
    });

    it('lists all visualMatch failures together (multi-failure case)', async () => {
      mockVisualMatch.processInstance.mockResolvedValueOnce({
        failures: [
          { name: 'a', verdict: 'no-baseline', message: 'no baseline for "a"' },
          { name: 'b', verdict: 'fail', message: 'visual diff for "b"' },
        ],
      });
      await service.processTestCompletion(testRunId, 'success', 'OK');

      const errArg = mockRunsService.handleValidationComplete.mock
        .calls[0][2] as string;
      expect(errArg).toContain('no baseline for "a"');
      expect(errArg).toContain('visual diff for "b"');
    });
  });
});
