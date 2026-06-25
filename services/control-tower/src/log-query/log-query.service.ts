import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class LogQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Gets HTTP logs, optionally filtered by instanceId
   */
  async getHttpLogs(
    instanceId?: string,
    limit: number = 100,
    offset: number = 0,
  ) {
    const where = instanceId ? { instanceId } : {};

    const [logs, total] = await Promise.all([
      this.prisma.httpLog.findMany({
        where,
        orderBy: { requestSentAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.httpLog.count({ where }),
    ]);

    // Calculate duration for each log
    const logsWithDuration = logs.map((log) => ({
      ...log,
      duration:
        log.requestSentAt && log.responseReceivedAt
          ? new Date(log.responseReceivedAt).getTime() -
            new Date(log.requestSentAt).getTime()
          : null,
    }));

    return {
      logs: logsWithDuration,
      total,
      limit,
      offset,
    };
  }

  /**
   * Gets console logs, optionally filtered by instanceId and instanceItemId
   */
  async getConsoleLogs(
    instanceId?: string,
    instanceItemId?: string,
    limit: number = 100,
    offset: number = 0,
  ) {
    const where: {
      instanceId?: string;
      instanceItemId?: string;
    } = {};

    if (instanceId) {
      where.instanceId = instanceId;
    }
    if (instanceItemId) {
      where.instanceItemId = instanceItemId;
    }

    const [logs, total] = await Promise.all([
      this.prisma.consoleLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.consoleLog.count({ where }),
    ]);

    return {
      logs,
      total,
      limit,
      offset,
    };
  }

  /**
   * Gets database logs, optionally filtered by instanceId
   */
  async getDatabaseLogs(
    instanceId?: string,
    limit: number = 500,
    offset: number = 0,
  ) {
    const where = instanceId ? { instanceId } : {};

    const [logs, total] = await Promise.all([
      this.prisma.databaseLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.databaseLog.count({ where }),
    ]);

    return {
      logs,
      total,
      limit,
      offset,
    };
  }

  /**
   * Gets test execution logs, optionally filtered by instanceId
   */
  async getTestExecutionLogs(
    instanceId?: string,
    limit: number = 1000,
    offset: number = 0,
  ) {
    const where = instanceId ? { instanceId } : {};

    const [logs, total] = await Promise.all([
      this.prisma.testExecutionLog.findMany({
        where,
        orderBy: { timestamp: 'asc' }, // Chronological order for execution timeline
        take: limit,
        skip: offset,
      }),
      this.prisma.testExecutionLog.count({ where }),
    ]);

    return {
      logs,
      total,
      limit,
      offset,
    };
  }

  /**
   * Gets message logs (broker produce/consume), optionally filtered by instanceId
   */
  async getMessageLogs(
    instanceId?: string,
    limit: number = 500,
    offset: number = 0,
  ) {
    const where = instanceId ? { instanceId } : {};

    const [logs, total] = await Promise.all([
      this.prisma.messageLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.messageLog.count({ where }),
    ]);

    return {
      logs,
      total,
      limit,
      offset,
    };
  }

  /**
   * Gets assertion results for a specific instance
   */
  async getAssertionResults(instanceId: string) {
    return this.prisma.assertionResult.findMany({
      where: { instanceId },
      orderBy: { timestamp: 'asc' },
    });
  }
}
