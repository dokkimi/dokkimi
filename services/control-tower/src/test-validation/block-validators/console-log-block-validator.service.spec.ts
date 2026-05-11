import { ConsoleLogBlockValidatorService } from './console-log-block-validator.service';
import { AssertionBlock, StepExecution } from '@dokkimi/config';

function makeStepExecution(overrides?: Partial<StepExecution>): StepExecution {
  return {
    stepIndex: 0,
    startTime: '2024-01-01T00:00:01.000Z',
    endTime: '2024-01-01T00:00:02.000Z',
    ...overrides,
  };
}

describe('ConsoleLogBlockValidatorService', () => {
  let service: ConsoleLogBlockValidatorService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      instanceItem: {
        findFirst: jest.fn().mockResolvedValue({ id: 'item-1' }),
      },
      consoleLog: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    service = new ConsoleLogBlockValidatorService(mockPrisma);
  });

  it('resolves service to instanceItemId', async () => {
    const block: AssertionBlock = {
      service: 'my-service',
      consoleAssertions: [{ count: { operator: 'gte', value: 1 } }],
    } as any;
    await service.validateConsoleLogBlock('inst-1', block, makeStepExecution());
    expect(mockPrisma.instanceItem.findFirst).toHaveBeenCalledWith({
      where: { instanceId: 'inst-1', itemDefinitionName: 'my-service' },
      select: { id: true },
    });
  });

  it('passes instanceItemId to consoleLog query when found', async () => {
    const block: AssertionBlock = {
      service: 'my-service',
      consoleAssertions: [{ count: { operator: 'gte', value: 0 } }],
    } as any;
    await service.validateConsoleLogBlock('inst-1', block, makeStepExecution());
    const call = mockPrisma.consoleLog.findMany.mock.calls[0][0];
    expect(call.where.instanceItemId).toBe('item-1');
  });

  it('omits instanceItemId when service not found', async () => {
    mockPrisma.instanceItem.findFirst.mockResolvedValue(null);
    const block: AssertionBlock = {
      service: 'unknown-service',
      consoleAssertions: [{ count: { operator: 'gte', value: 0 } }],
    } as any;
    await service.validateConsoleLogBlock('inst-1', block, makeStepExecution());
    const call = mockPrisma.consoleLog.findMany.mock.calls[0][0];
    expect(call.where.instanceItemId).toBeUndefined();
  });

  it('filters by level when provided', async () => {
    const block: AssertionBlock = {
      service: 'svc',
      consoleAssertions: [
        { level: 'error', count: { operator: 'eq', value: 0 } },
      ],
    } as any;
    await service.validateConsoleLogBlock('inst-1', block, makeStepExecution());
    const call = mockPrisma.consoleLog.findMany.mock.calls[0][0];
    expect(call.where.level).toBe('ERROR');
  });

  it('does not filter by level when not provided', async () => {
    const block: AssertionBlock = {
      service: 'svc',
      consoleAssertions: [{ count: { operator: 'gte', value: 0 } }],
    } as any;
    await service.validateConsoleLogBlock('inst-1', block, makeStepExecution());
    const call = mockPrisma.consoleLog.findMany.mock.calls[0][0];
    expect(call.where.level).toBeUndefined();
  });

  describe('message filtering', () => {
    beforeEach(() => {
      mockPrisma.consoleLog.findMany.mockResolvedValue([
        { message: 'User created successfully' },
        { message: 'Database connection established' },
        { message: 'Error: something failed' },
      ]);
    });

    it('filters with eq operator', async () => {
      const block: AssertionBlock = {
        service: 'svc',
        consoleAssertions: [
          {
            message: { operator: 'eq', value: 'User created successfully' },
            count: { operator: 'eq', value: 1 },
          },
        ],
      } as any;
      const results = await service.validateConsoleLogBlock(
        'inst-1',
        block,
        makeStepExecution(),
      );
      expect(results[0].passed).toBe(true);
    });

    it('filters with contains operator', async () => {
      const block: AssertionBlock = {
        service: 'svc',
        consoleAssertions: [
          {
            message: { operator: 'contains', value: 'connection' },
            count: { operator: 'eq', value: 1 },
          },
        ],
      } as any;
      const results = await service.validateConsoleLogBlock(
        'inst-1',
        block,
        makeStepExecution(),
      );
      expect(results[0].passed).toBe(true);
    });

    it('filters with matches (regex) operator', async () => {
      const block: AssertionBlock = {
        service: 'svc',
        consoleAssertions: [
          {
            message: { operator: 'matches', value: '^Error:' },
            count: { operator: 'eq', value: 1 },
          },
        ],
      } as any;
      const results = await service.validateConsoleLogBlock(
        'inst-1',
        block,
        makeStepExecution(),
      );
      expect(results[0].passed).toBe(true);
    });

    it('handles invalid regex gracefully', async () => {
      mockPrisma.consoleLog.findMany.mockResolvedValue([{ message: 'test' }]);
      const block: AssertionBlock = {
        service: 'svc',
        consoleAssertions: [
          {
            message: { operator: 'matches', value: '[invalid' },
            count: { operator: 'eq', value: 0 },
          },
        ],
      } as any;
      const results = await service.validateConsoleLogBlock(
        'inst-1',
        block,
        makeStepExecution(),
      );
      expect(results[0].passed).toBe(true);
    });

    it('returns false for unknown message operator', async () => {
      mockPrisma.consoleLog.findMany.mockResolvedValue([{ message: 'test' }]);
      const block: AssertionBlock = {
        service: 'svc',
        consoleAssertions: [
          {
            message: { operator: 'unknownOp', value: 'test' },
            count: { operator: 'eq', value: 0 },
          },
        ],
      } as any;
      const results = await service.validateConsoleLogBlock(
        'inst-1',
        block,
        makeStepExecution(),
      );
      expect(results[0].passed).toBe(true);
    });
  });

  it('validates count assertion on matched logs', async () => {
    mockPrisma.consoleLog.findMany.mockResolvedValue([
      { message: 'log1' },
      { message: 'log2' },
    ]);
    const block: AssertionBlock = {
      service: 'svc',
      consoleAssertions: [{ count: { operator: 'eq', value: 2 } }],
    } as any;
    const results = await service.validateConsoleLogBlock(
      'inst-1',
      block,
      makeStepExecution(),
    );
    expect(results[0].passed).toBe(true);
    expect(results[0].actual).toBe(2);
  });

  it('builds descriptive path label', async () => {
    mockPrisma.consoleLog.findMany.mockResolvedValue([]);
    const block: AssertionBlock = {
      service: 'svc',
      consoleAssertions: [
        {
          level: 'error',
          message: { operator: 'contains', value: 'fail' },
          count: { operator: 'eq', value: 0 },
        },
      ],
    } as any;
    const results = await service.validateConsoleLogBlock(
      'inst-1',
      block,
      makeStepExecution(),
    );
    expect(results[0].path).toBe('console(ERROR, contains "fail")');
    expect(results[0].resultKind).toBe('count');
  });

  it('skips disabled assertions', async () => {
    const block: AssertionBlock = {
      service: 'svc',
      consoleAssertions: [
        { count: { operator: 'eq', value: 999 }, disabled: true },
        { count: { operator: 'gte', value: 0 } },
      ],
    } as any;
    const results = await service.validateConsoleLogBlock(
      'inst-1',
      block,
      makeStepExecution(),
    );
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
  });

  it('handles multiple console assertions', async () => {
    mockPrisma.consoleLog.findMany.mockResolvedValue([{ message: 'info msg' }]);
    const block: AssertionBlock = {
      service: 'svc',
      consoleAssertions: [
        { count: { operator: 'gte', value: 1 } },
        { count: { operator: 'lte', value: 5 } },
      ],
    } as any;
    const results = await service.validateConsoleLogBlock(
      'inst-1',
      block,
      makeStepExecution(),
    );
    expect(results).toHaveLength(2);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(true);
  });

  describe('retry logic', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('retries when assertions expecting logs fail', async () => {
      mockPrisma.consoleLog.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ message: 'PRE: Starting' }]);
      const block: AssertionBlock = {
        service: 'svc',
        consoleAssertions: [
          {
            message: { operator: 'contains', value: 'PRE: Starting' },
            count: { operator: 'gte', value: 1 },
          },
        ],
      } as any;
      const promise = service.validateConsoleLogBlock(
        'inst-1',
        block,
        makeStepExecution(),
      );
      await jest.advanceTimersByTimeAsync(1000);
      const results = await promise;
      expect(results[0].passed).toBe(true);
      expect(mockPrisma.consoleLog.findMany).toHaveBeenCalledTimes(2);
    });

    it('does not retry when assertion expects zero logs', async () => {
      mockPrisma.consoleLog.findMany.mockResolvedValue([
        { message: 'unexpected' },
      ]);
      const block: AssertionBlock = {
        service: 'svc',
        consoleAssertions: [{ count: { operator: 'eq', value: 0 } }],
      } as any;
      const results = await service.validateConsoleLogBlock(
        'inst-1',
        block,
        makeStepExecution(),
      );
      expect(results[0].passed).toBe(false);
      expect(mockPrisma.consoleLog.findMany).toHaveBeenCalledTimes(1);
    });

    it('returns failure after exhausting retries', async () => {
      mockPrisma.consoleLog.findMany.mockResolvedValue([]);
      const block: AssertionBlock = {
        service: 'svc',
        consoleAssertions: [
          {
            message: { operator: 'contains', value: 'never arrives' },
            count: { operator: 'gte', value: 1 },
          },
        ],
      } as any;
      const promise = service.validateConsoleLogBlock(
        'inst-1',
        block,
        makeStepExecution(),
      );
      // Advance through all retries (3 x 1000ms)
      await jest.advanceTimersByTimeAsync(3000);
      const results = await promise;
      expect(results[0].passed).toBe(false);
      // 1 initial + 3 retries
      expect(mockPrisma.consoleLog.findMany).toHaveBeenCalledTimes(4);
    });
  });
});
