import { StepValidatorService } from './step-validator.service';
import type { StepExecution, TestDefinition } from '@dokkimi/config';

function makeStep(overrides?: any) {
  return {
    name: 'step',
    action: { type: 'httpCall', method: 'GET', url: '/api' },
    assertions: [],
    ...overrides,
  };
}

function makeExecution(
  stepIndex: number,
  overrides?: Partial<StepExecution>,
): StepExecution {
  return {
    stepIndex,
    startTime: '2026-01-01T00:00:01.000Z',
    endTime: '2026-01-01T00:00:02.000Z',
    ...overrides,
  };
}

function makeTest(overrides?: any): TestDefinition {
  return {
    name: 'test-1',
    steps: [makeStep()],
    ...overrides,
  } as TestDefinition;
}

describe('StepValidatorService', () => {
  let service: StepValidatorService;

  const mockLogger: any = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  };

  const mockPrisma: any = {
    httpLog: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    testExecutionLog: {
      create: jest.fn().mockResolvedValue(undefined),
    },
    assertionResult: {
      create: jest.fn().mockResolvedValue(undefined),
    },
  };

  const mockAssertionValidator: any = {
    validateAssertions: jest.fn().mockResolvedValue([]),
  };

  const mockVariableContext: any = {
    clear: jest.fn(),
    set: jest.fn(),
    resolveObject: jest.fn((obj: any) => obj),
  };

  beforeEach(() => {
    service = new StepValidatorService(
      mockLogger,
      mockPrisma,
      mockAssertionValidator,
      mockVariableContext,
    );
    jest.clearAllMocks();
    mockPrisma.httpLog.findMany.mockResolvedValue([]);
    mockPrisma.testExecutionLog.create.mockResolvedValue(undefined);
    mockPrisma.assertionResult.create.mockResolvedValue(undefined);
    mockAssertionValidator.validateAssertions.mockResolvedValue([]);
    mockVariableContext.resolveObject.mockImplementation((obj: any) => obj);
  });

  describe('variable seeding', () => {
    it('clears variable context before each run', async () => {
      await service.validateTestAssertions(
        'inst-1',
        [makeTest()],
        [makeExecution(0)],
      );
      expect(mockVariableContext.clear).toHaveBeenCalled();
    });

    it('seeds definition-level variables', async () => {
      await service.validateTestAssertions(
        'inst-1',
        [makeTest()],
        [makeExecution(0)],
        false,
        { baseUrl: 'http://api', apiKey: 'key123' },
      );
      expect(mockVariableContext.set).toHaveBeenCalledWith(
        'baseUrl',
        'http://api',
      );
      expect(mockVariableContext.set).toHaveBeenCalledWith('apiKey', 'key123');
    });

    it('seeds test-level variables (override definition-level)', async () => {
      const test = makeTest({ variables: { token: 'abc' } });
      await service.validateTestAssertions(
        'inst-1',
        [test],
        [makeExecution(0)],
        false,
        { token: 'def-level' },
      );
      const setCalls = mockVariableContext.set.mock.calls;
      const tokenCalls = setCalls.filter((c: any) => c[0] === 'token');
      expect(tokenCalls[tokenCalls.length - 1][1]).toBe('abc');
    });
  });

  describe('step iteration', () => {
    it('returns passed when all steps pass', async () => {
      mockAssertionValidator.validateAssertions.mockResolvedValue([
        { passed: true, resultKind: 'field', path: 'status', blockIndex: 0 },
      ]);
      const result = await service.validateTestAssertions(
        'inst-1',
        [makeTest({ steps: [makeStep({ assertions: [{}] })] })],
        [makeExecution(0)],
      );
      expect(result.passed).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('returns failed when a step fails', async () => {
      mockAssertionValidator.validateAssertions.mockResolvedValue([
        {
          passed: false,
          resultKind: 'field',
          path: 'status',
          blockIndex: 0,
          error: 'mismatch',
        },
      ]);
      const result = await service.validateTestAssertions(
        'inst-1',
        [makeTest({ steps: [makeStep({ assertions: [{}] })] })],
        [makeExecution(0)],
      );
      expect(result.passed).toBe(false);
      expect(result.error).toContain('mismatch');
    });

    it('skips missing step execution when partial=true', async () => {
      const result = await service.validateTestAssertions(
        'inst-1',
        [makeTest()],
        [],
        true,
      );
      expect(result.passed).toBe(true);
      expect(mockPrisma.assertionResult.create).not.toHaveBeenCalled();
    });

    it('writes SKIPPED for missing step execution when partial=false', async () => {
      const result = await service.validateTestAssertions(
        'inst-1',
        [makeTest()],
        [],
        false,
      );
      expect(result.passed).toBe(true);
      expect(mockPrisma.assertionResult.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          resultKind: 'SKIPPED',
          passed: false,
        }),
      });
    });
  });

  describe('stopOnFailure', () => {
    it('stops and writes NOT_VALIDATED for remaining steps when stopOnFailure=true', async () => {
      mockAssertionValidator.validateAssertions.mockResolvedValue([
        { passed: false, resultKind: 'field', blockIndex: 0, error: 'fail' },
      ]);

      const test = makeTest({
        stopOnFailure: true,
        steps: [
          makeStep({ assertions: [{}] }),
          makeStep({ assertions: [{}] }),
          makeStep({ assertions: [{}] }),
        ],
      });

      const result = await service.validateTestAssertions(
        'inst-1',
        [test],
        [makeExecution(0), makeExecution(1), makeExecution(2)],
      );

      expect(result.passed).toBe(false);
      expect(result.telemetry?.stoppedOnFailure).toBe(true);

      const skipCalls = mockPrisma.assertionResult.create.mock.calls.filter(
        (c: any) => c[0].data.resultKind === 'NOT_VALIDATED',
      );
      expect(skipCalls).toHaveLength(2);
    });

    it('continues to next step when stopOnFailure=false', async () => {
      mockAssertionValidator.validateAssertions
        .mockResolvedValueOnce([
          { passed: false, resultKind: 'field', blockIndex: 0, error: 'fail' },
        ])
        .mockResolvedValueOnce([
          { passed: true, resultKind: 'field', blockIndex: 0 },
        ]);

      const test = makeTest({
        stopOnFailure: false,
        steps: [makeStep({ assertions: [{}] }), makeStep({ assertions: [{}] })],
      });

      const result = await service.validateTestAssertions(
        'inst-1',
        [test],
        [makeExecution(0), makeExecution(1)],
      );

      expect(result.passed).toBe(false);
      expect(result.telemetry?.stoppedOnFailure).toBe(false);
      expect(mockAssertionValidator.validateAssertions).toHaveBeenCalledTimes(
        2,
      );
    });

    it('defaults stopOnFailure to true', async () => {
      mockAssertionValidator.validateAssertions.mockResolvedValue([
        { passed: false, resultKind: 'field', blockIndex: 0 },
      ]);

      const test = makeTest({
        steps: [makeStep({ assertions: [{}] }), makeStep({ assertions: [{}] })],
      });
      delete (test as any).stopOnFailure;

      const result = await service.validateTestAssertions(
        'inst-1',
        [test],
        [makeExecution(0), makeExecution(1)],
      );

      expect(result.telemetry?.stoppedOnFailure).toBe(true);
    });
  });

  describe('variable resolution failure', () => {
    it('reports error and stops when stopOnFailure=true', async () => {
      mockVariableContext.resolveObject.mockImplementation(() => {
        throw new Error('undefined variable {{missing}}');
      });

      const test = makeTest({
        stopOnFailure: true,
        steps: [makeStep(), makeStep()],
      });

      const result = await service.validateTestAssertions(
        'inst-1',
        [test],
        [makeExecution(0), makeExecution(1)],
      );

      expect(result.passed).toBe(false);
      expect(result.error).toContain('Variable resolution failed');
      expect(result.telemetry?.stoppedOnFailure).toBe(true);
    });

    it('continues when stopOnFailure=false', async () => {
      mockVariableContext.resolveObject
        .mockImplementationOnce(() => {
          throw new Error('undefined variable');
        })
        .mockImplementation((obj: any) => obj);

      const test = makeTest({
        stopOnFailure: false,
        steps: [makeStep(), makeStep()],
      });

      const result = await service.validateTestAssertions(
        'inst-1',
        [test],
        [makeExecution(0), makeExecution(1)],
      );

      expect(result.passed).toBe(false);
      expect(mockAssertionValidator.validateAssertions).toHaveBeenCalledTimes(
        1,
      );
    });
  });

  describe('assertion validator failure', () => {
    it('reports error and stops when stopOnFailure=true', async () => {
      mockAssertionValidator.validateAssertions.mockRejectedValue(
        new Error('validator crash'),
      );

      const result = await service.validateTestAssertions(
        'inst-1',
        [makeTest({ steps: [makeStep(), makeStep()] })],
        [makeExecution(0), makeExecution(1)],
      );

      expect(result.passed).toBe(false);
      expect(result.error).toContain('Assertion validation error');
      expect(result.error).toContain('validator crash');
    });

    it('continues when stopOnFailure=false', async () => {
      mockAssertionValidator.validateAssertions
        .mockRejectedValueOnce(new Error('crash'))
        .mockResolvedValueOnce([]);

      const test = makeTest({
        stopOnFailure: false,
        steps: [makeStep(), makeStep()],
      });

      const result = await service.validateTestAssertions(
        'inst-1',
        [test],
        [makeExecution(0), makeExecution(1)],
      );

      expect(result.passed).toBe(false);
      expect(mockAssertionValidator.validateAssertions).toHaveBeenCalledTimes(
        2,
      );
    });
  });

  describe('result storage', () => {
    it('stores each assertion result via prisma', async () => {
      mockAssertionValidator.validateAssertions.mockResolvedValue([
        {
          passed: true,
          resultKind: 'field',
          path: 'status',
          operator: 'eq',
          expected: 200,
          actual: 200,
          blockIndex: 0,
        },
      ]);

      await service.validateTestAssertions(
        'inst-1',
        [makeTest({ steps: [makeStep({ assertions: [{}] })] })],
        [makeExecution(0)],
      );

      expect(mockPrisma.assertionResult.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          instanceId: 'inst-1',
          stepIndex: 0,
          assertionIndex: 0,
          passed: true,
          path: 'status',
          operator: 'eq',
        }),
      });
    });

    it('logs ASSERTION_PASSED and ASSERTION_FAILED events', async () => {
      mockAssertionValidator.validateAssertions.mockResolvedValue([
        { passed: true, resultKind: 'field', blockIndex: 0 },
        { passed: false, resultKind: 'field', blockIndex: 0, error: 'fail' },
      ]);

      await service.validateTestAssertions(
        'inst-1',
        [makeTest({ steps: [makeStep({ assertions: [{}] })] })],
        [makeExecution(0)],
      );

      const logCalls = mockPrisma.testExecutionLog.create.mock.calls;
      const eventTypes = logCalls.map((c: any) => c[0].data.eventType);
      expect(eventTypes).toContain('ASSERTION_PASSED');
      expect(eventTypes).toContain('ASSERTION_FAILED');
    });

    it('warns but continues if prisma storage fails', async () => {
      mockAssertionValidator.validateAssertions.mockResolvedValue([
        { passed: true, resultKind: 'field', blockIndex: 0 },
      ]);
      mockPrisma.assertionResult.create.mockRejectedValue(
        new Error('DB error'),
      );

      const result = await service.validateTestAssertions(
        'inst-1',
        [makeTest({ steps: [makeStep({ assertions: [{}] })] })],
        [makeExecution(0)],
      );

      expect(result.passed).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to store assertion result'),
      );
    });
  });

  describe('assertion type derivation', () => {
    it('derives consoleLog type from block with service', async () => {
      mockAssertionValidator.validateAssertions.mockResolvedValue([
        { passed: true, resultKind: 'count', blockIndex: 0 },
      ]);

      await service.validateTestAssertions(
        'inst-1',
        [
          makeTest({
            steps: [
              makeStep({
                assertions: [{ service: 'api', consoleAssertions: [] }],
              }),
            ],
          }),
        ],
        [makeExecution(0)],
      );

      expect(mockPrisma.assertionResult.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ assertionType: 'consoleLog' }),
      });
    });

    it('derives httpCall type from block with match', async () => {
      mockAssertionValidator.validateAssertions.mockResolvedValue([
        { passed: true, resultKind: 'field', blockIndex: 0 },
      ]);

      await service.validateTestAssertions(
        'inst-1',
        [
          makeTest({
            steps: [
              makeStep({
                assertions: [{ match: { method: 'GET' }, fieldAssertions: [] }],
              }),
            ],
          }),
        ],
        [makeExecution(0)],
      );

      expect(mockPrisma.assertionResult.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ assertionType: 'httpCall' }),
      });
    });

    it('derives self type for blocks without service or match', async () => {
      mockAssertionValidator.validateAssertions.mockResolvedValue([
        { passed: true, resultKind: 'field', blockIndex: 0 },
      ]);

      await service.validateTestAssertions(
        'inst-1',
        [
          makeTest({
            steps: [makeStep({ assertions: [{ fieldAssertions: [] }] })],
          }),
        ],
        [makeExecution(0)],
      );

      expect(mockPrisma.assertionResult.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ assertionType: 'self' }),
      });
    });
  });

  describe('telemetry', () => {
    it('counts assertions correctly', async () => {
      mockAssertionValidator.validateAssertions.mockResolvedValue([
        { passed: true, resultKind: 'field', blockIndex: 0 },
        { passed: false, resultKind: 'field', blockIndex: 0, error: 'fail' },
        { passed: true, resultKind: 'field', blockIndex: 0 },
      ]);

      const result = await service.validateTestAssertions(
        'inst-1',
        [
          makeTest({
            stopOnFailure: false,
            steps: [makeStep({ assertions: [{}] })],
          }),
        ],
        [makeExecution(0)],
      );

      expect(result.telemetry?.assertionCount).toBe(3);
      expect(result.telemetry?.passedAssertionCount).toBe(2);
      expect(result.telemetry?.failedAssertionCount).toBe(1);
    });

    it('reports totalStepCount across multiple tests', async () => {
      const result = await service.validateTestAssertions(
        'inst-1',
        [
          makeTest({ steps: [makeStep(), makeStep()] }),
          makeTest({ steps: [makeStep()] }),
        ],
        [makeExecution(0), makeExecution(1), makeExecution(2)],
      );

      expect(result.telemetry?.totalStepCount).toBe(3);
    });

    it('reports hasExtract when steps have extract', async () => {
      const result = await service.validateTestAssertions(
        'inst-1',
        [makeTest({ steps: [makeStep({ extract: { id: '$.body.id' } })] })],
        [makeExecution(0)],
      );

      expect(result.telemetry?.hasExtract).toBe(true);
    });

    it('reports hasExtract=false when no steps have extract', async () => {
      const result = await service.validateTestAssertions(
        'inst-1',
        [makeTest()],
        [makeExecution(0)],
      );

      expect(result.telemetry?.hasExtract).toBe(false);
    });

    it('counts skipped steps', async () => {
      const result = await service.validateTestAssertions(
        'inst-1',
        [makeTest({ steps: [makeStep(), makeStep()] })],
        [],
        false,
      );

      expect(result.telemetry?.skippedStepCount).toBe(2);
    });
  });

  describe('HTTP log windowing', () => {
    it('queries logs with 100ms buffer on both sides', async () => {
      await service.validateTestAssertions(
        'inst-1',
        [makeTest()],
        [
          makeExecution(0, {
            startTime: '2026-01-01T00:00:10.000Z',
            endTime: '2026-01-01T00:00:11.000Z',
          }),
        ],
      );

      const call = mockPrisma.httpLog.findMany.mock.calls[0][0];
      const gte = new Date(call.where.requestSentAt.gte);
      const lte = new Date(call.where.requestSentAt.lte);
      expect(gte.getTime()).toBe(
        new Date('2026-01-01T00:00:09.900Z').getTime(),
      );
      expect(lte.getTime()).toBe(
        new Date('2026-01-01T00:00:11.100Z').getTime(),
      );
    });
  });

  describe('multiple tests flattened', () => {
    it('flattens steps across multiple test definitions', async () => {
      const tests = [
        makeTest({ name: 'test-1', steps: [makeStep(), makeStep()] }),
        makeTest({ name: 'test-2', steps: [makeStep()] }),
      ];

      await service.validateTestAssertions('inst-1', tests, [
        makeExecution(0),
        makeExecution(1),
        makeExecution(2),
      ]);

      expect(mockAssertionValidator.validateAssertions).toHaveBeenCalledTimes(
        3,
      );
    });
  });

  describe('error messages', () => {
    it('includes expected/actual when no error message on failed assertion', async () => {
      mockAssertionValidator.validateAssertions.mockResolvedValue([
        {
          passed: false,
          resultKind: 'field',
          blockIndex: 0,
          expected: 200,
          actual: 404,
        },
      ]);

      const result = await service.validateTestAssertions(
        'inst-1',
        [
          makeTest({
            stopOnFailure: false,
            steps: [makeStep({ assertions: [{}] })],
          }),
        ],
        [makeExecution(0)],
      );

      expect(result.error).toContain('Expected 200');
      expect(result.error).toContain('got 404');
    });

    it('uses error message when present', async () => {
      mockAssertionValidator.validateAssertions.mockResolvedValue([
        {
          passed: false,
          resultKind: 'field',
          blockIndex: 0,
          error: 'type mismatch: expected string got number',
        },
      ]);

      const result = await service.validateTestAssertions(
        'inst-1',
        [
          makeTest({
            stopOnFailure: false,
            steps: [makeStep({ assertions: [{}] })],
          }),
        ],
        [makeExecution(0)],
      );

      expect(result.error).toContain('type mismatch');
    });
  });

  describe('execution log failures', () => {
    it('warns but continues if testExecutionLog.create fails', async () => {
      mockPrisma.testExecutionLog.create.mockRejectedValue(
        new Error('log error'),
      );

      const result = await service.validateTestAssertions(
        'inst-1',
        [makeTest()],
        [makeExecution(0)],
      );

      expect(result.passed).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });
});
