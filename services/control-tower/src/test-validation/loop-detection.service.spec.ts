import { Test, TestingModule } from '@nestjs/testing';
import { LoopDetectionService } from './loop-detection.service';
import { PrismaService } from '../prisma/prisma.service';
import { ColoredLoggerService } from '../logging/colored-logger.service';

describe('LoopDetectionService', () => {
  let service: LoopDetectionService;

  const mockPrisma = {
    httpLog: {
      findMany: jest.fn(),
    },
  };

  const mockLogger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoopDetectionService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ColoredLoggerService, useValue: mockLogger },
      ],
    }).compile();

    service = module.get(LoopDetectionService);
  });

  it('should return no loop when there are no HTTP logs', async () => {
    mockPrisma.httpLog.findMany.mockResolvedValue([]);

    const result = await service.detectLoops('inst-1');
    expect(result).toEqual({ hasLoop: false, totalRequests: 0 });
  });

  it('should return no loop when requests are under all thresholds', async () => {
    const logs = Array.from({ length: 10 }, () => ({
      origin: 'svc-a',
      target: 'svc-b',
      timestamp: new Date(),
    }));
    mockPrisma.httpLog.findMany.mockResolvedValue(logs);

    const result = await service.detectLoops('inst-1');
    expect(result.hasLoop).toBe(false);
    expect(result.totalRequests).toBe(10);
  });

  it('should detect a loop when total requests exceed maxTotalCalls', async () => {
    const logs = Array.from({ length: 501 }, (_, i) => ({
      origin: `svc-${i % 100}`,
      target: `svc-${(i + 1) % 100}`,
      timestamp: new Date(),
    }));
    mockPrisma.httpLog.findMany.mockResolvedValue(logs);

    const result = await service.detectLoops('inst-1');
    expect(result.hasLoop).toBe(true);
    expect(result.reason).toContain('501');
    expect(result.reason).toContain('500');
    expect(result.totalRequests).toBe(501);
  });

  it('should detect a loop when a single pair exceeds maxCallsPerPair', async () => {
    const logs = Array.from({ length: 51 }, () => ({
      origin: 'svc-a',
      target: 'svc-b',
      timestamp: new Date(),
    }));
    mockPrisma.httpLog.findMany.mockResolvedValue(logs);

    const result = await service.detectLoops('inst-1');
    expect(result.hasLoop).toBe(true);
    expect(result.reason).toContain('svc-a→svc-b');
    expect(result.reason).toContain('51');
    expect(result.suspiciousPairs).toEqual([['svc-a→svc-b', 51]]);
    expect(result.totalRequests).toBe(51);
  });

  it('should only flag pairs that exceed the threshold', async () => {
    const logs = [
      ...Array.from({ length: 51 }, () => ({
        origin: 'svc-a',
        target: 'svc-b',
        timestamp: new Date(),
      })),
      ...Array.from({ length: 10 }, () => ({
        origin: 'svc-c',
        target: 'svc-d',
        timestamp: new Date(),
      })),
    ];
    mockPrisma.httpLog.findMany.mockResolvedValue(logs);

    const result = await service.detectLoops('inst-1');
    expect(result.hasLoop).toBe(true);
    expect(result.suspiciousPairs).toHaveLength(1);
    expect(result.suspiciousPairs![0][0]).toBe('svc-a→svc-b');
  });

  it('should return no loop when detection is disabled', async () => {
    const result = await service.detectLoops('inst-1', { enabled: false });
    expect(result).toEqual({ hasLoop: false, totalRequests: 0 });
    expect(mockPrisma.httpLog.findMany).not.toHaveBeenCalled();
  });

  it('should use custom thresholds from partial config', async () => {
    const logs = Array.from({ length: 6 }, () => ({
      origin: 'svc-a',
      target: 'svc-b',
      timestamp: new Date(),
    }));
    mockPrisma.httpLog.findMany.mockResolvedValue(logs);

    const result = await service.detectLoops('inst-1', {
      maxCallsPerPair: 5,
    });
    expect(result.hasLoop).toBe(true);
    expect(result.suspiciousPairs![0][1]).toBe(6);
  });

  it('should handle self-calls (origin === target)', async () => {
    const logs = Array.from({ length: 51 }, () => ({
      origin: 'svc-a',
      target: 'svc-a',
      timestamp: new Date(),
    }));
    mockPrisma.httpLog.findMany.mockResolvedValue(logs);

    const result = await service.detectLoops('inst-1');
    expect(result.hasLoop).toBe(true);
    expect(result.suspiciousPairs![0][0]).toBe('svc-a→svc-a');
  });

  it('should skip logs with null origin or target', async () => {
    const logs = [
      { origin: null, target: 'svc-b', timestamp: new Date() },
      { origin: 'svc-a', target: null, timestamp: new Date() },
      ...Array.from({ length: 5 }, () => ({
        origin: 'svc-a',
        target: 'svc-b',
        timestamp: new Date(),
      })),
    ];
    mockPrisma.httpLog.findMany.mockResolvedValue(logs);

    const result = await service.detectLoops('inst-1');
    expect(result.hasLoop).toBe(false);
    expect(result.totalRequests).toBe(7);
  });

  it('should query logs filtered by instanceId', async () => {
    mockPrisma.httpLog.findMany.mockResolvedValue([]);

    await service.detectLoops('specific-instance');
    expect(mockPrisma.httpLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { instanceId: 'specific-instance' },
      }),
    );
  });
});
