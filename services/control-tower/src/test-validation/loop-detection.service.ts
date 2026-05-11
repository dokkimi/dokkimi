import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ColoredLoggerService } from '../logging/colored-logger.service';

export interface LoopDetectionResult {
  hasLoop: boolean;
  reason?: string;
  suspiciousPairs?: Array<[string, number]>;
  totalRequests: number;
}

export interface LoopDetectionConfig {
  enabled: boolean;
  maxCallsPerPair: number;
  maxTotalCalls: number;
}

/**
 * Service for detecting infinite loops in service-to-service calls
 */
@Injectable()
export class LoopDetectionService {
  private readonly DEFAULT_CONFIG: LoopDetectionConfig = {
    enabled: true,
    maxCallsPerPair: 50,
    maxTotalCalls: 500,
  };

  constructor(
    private readonly logger: ColoredLoggerService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Detects infinite loops by analyzing HTTP logs
   */
  async detectLoops(
    instanceId: string,
    config: Partial<LoopDetectionConfig> = {},
  ): Promise<LoopDetectionResult> {
    const finalConfig = { ...this.DEFAULT_CONFIG, ...config };

    if (!finalConfig.enabled) {
      return { hasLoop: false, totalRequests: 0 };
    }

    const logs = await this.prisma.httpLog.findMany({
      where: { instanceId },
      orderBy: { timestamp: 'asc' },
      select: { origin: true, target: true, timestamp: true },
    });

    // Check total threshold first (fast path)
    if (logs.length > finalConfig.maxTotalCalls) {
      return {
        hasLoop: true,
        reason: `Total calls (${logs.length}) exceeded limit (${finalConfig.maxTotalCalls})`,
        totalRequests: logs.length,
      };
    }

    // Count requests per service pair
    const pairCounts = new Map<string, number>();
    for (const log of logs) {
      if (log.origin && log.target) {
        const key = `${log.origin}→${log.target}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }

    // Flag if any pair exceeds threshold
    const suspiciousPairs = [...pairCounts.entries()].filter(
      ([_, count]) => count > finalConfig.maxCallsPerPair,
    );

    if (suspiciousPairs.length > 0) {
      return {
        hasLoop: true,
        reason: `Pair ${suspiciousPairs[0][0]} called ${suspiciousPairs[0][1]} times (limit: ${finalConfig.maxCallsPerPair})`,
        suspiciousPairs,
        totalRequests: logs.length,
      };
    }

    return { hasLoop: false, totalRequests: logs.length };
  }
}
