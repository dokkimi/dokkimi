import { Test, TestingModule } from '@nestjs/testing';
import { QuiescenceDetectionService } from './quiescence-detection.service';
import { PrismaService } from '../prisma/prisma.service';
import { ColoredLoggerService } from '../logging/colored-logger.service';
import { TelemetryService } from '../telemetry/telemetry.service';

describe('QuiescenceDetectionService', () => {
  let service: QuiescenceDetectionService;

  const mockPrisma = {
    httpLog: { count: jest.fn() },
    consoleLog: { count: jest.fn() },
  };

  const mockLogger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  };

  const mockTelemetry = {
    track: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuiescenceDetectionService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ColoredLoggerService, useValue: mockLogger },
        { provide: TelemetryService, useValue: mockTelemetry },
      ],
    }).compile();

    service = module.get(QuiescenceDetectionService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should settle quickly when no new logs arrive', async () => {
    mockPrisma.httpLog.count.mockResolvedValue(0);
    mockPrisma.consoleLog.count.mockResolvedValue(0);

    const promise = service.waitForLogsToSettle('inst-1', new Date());

    // Advance past the initial 500ms sleep
    await jest.advanceTimersByTimeAsync(500);
    // Advance past the quiescence period (500ms) via poll cycles (100ms each)
    for (let i = 0; i < 6; i++) {
      await jest.advanceTimersByTimeAsync(100);
    }

    await promise;
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('Logs settled'),
    );
  });

  it('should wait for logs to stop arriving before settling', async () => {
    let httpCount = 0;
    mockPrisma.httpLog.count.mockImplementation(() => {
      return Promise.resolve(httpCount);
    });
    mockPrisma.consoleLog.count.mockResolvedValue(0);

    const promise = service.waitForLogsToSettle('inst-1', new Date());

    // Advance past initial 500ms sleep
    await jest.advanceTimersByTimeAsync(500);

    // First few polls: logs are still arriving
    await jest.advanceTimersByTimeAsync(100);
    httpCount = 5;
    await jest.advanceTimersByTimeAsync(100);
    httpCount = 10;
    await jest.advanceTimersByTimeAsync(100);

    // Logs stop arriving — advance enough for quiescence
    for (let i = 0; i < 6; i++) {
      await jest.advanceTimersByTimeAsync(100);
    }

    await promise;
    expect(mockLogger.log).toHaveBeenCalled();
  });

  it('should time out after MAX_WAIT_MS and track telemetry', async () => {
    let httpCount = 0;
    mockPrisma.httpLog.count.mockImplementation(() => {
      httpCount++;
      return Promise.resolve(httpCount);
    });
    mockPrisma.consoleLog.count.mockResolvedValue(0);

    const promise = service.waitForLogsToSettle('inst-1', new Date());

    // Advance past initial sleep + MAX_WAIT_MS
    await jest.advanceTimersByTimeAsync(500);
    for (let i = 0; i < 110; i++) {
      await jest.advanceTimersByTimeAsync(100);
    }

    await promise;
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('timeout'),
    );
    expect(mockTelemetry.track).toHaveBeenCalledWith(
      'tvs_quiescence_timeout',
      expect.objectContaining({ module: 'test-validation' }),
    );
  });

  it('should consider both HTTP and console log counts', async () => {
    let consoleCount = 0;
    mockPrisma.httpLog.count.mockResolvedValue(0);
    mockPrisma.consoleLog.count.mockImplementation(() => {
      return Promise.resolve(consoleCount);
    });

    const promise = service.waitForLogsToSettle('inst-1', new Date());

    await jest.advanceTimersByTimeAsync(500);

    // Console logs arrive
    await jest.advanceTimersByTimeAsync(100);
    consoleCount = 3;
    await jest.advanceTimersByTimeAsync(100);

    // Stop arriving
    for (let i = 0; i < 6; i++) {
      await jest.advanceTimersByTimeAsync(100);
    }

    await promise;
    expect(mockPrisma.consoleLog.count).toHaveBeenCalled();
    expect(mockPrisma.httpLog.count).toHaveBeenCalled();
  });

  it('should filter logs by instanceId and afterTime', async () => {
    mockPrisma.httpLog.count.mockResolvedValue(0);
    mockPrisma.consoleLog.count.mockResolvedValue(0);

    const afterTime = new Date('2026-01-01T00:00:00Z');
    const promise = service.waitForLogsToSettle('inst-42', afterTime);

    await jest.advanceTimersByTimeAsync(500);
    for (let i = 0; i < 6; i++) {
      await jest.advanceTimersByTimeAsync(100);
    }

    await promise;

    expect(mockPrisma.httpLog.count).toHaveBeenCalledWith({
      where: { instanceId: 'inst-42', timestamp: { gte: afterTime } },
    });
    expect(mockPrisma.consoleLog.count).toHaveBeenCalledWith({
      where: { instanceId: 'inst-42', timestamp: { gte: afterTime } },
    });
  });
});
