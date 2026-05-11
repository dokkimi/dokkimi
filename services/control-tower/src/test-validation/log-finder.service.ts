import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HttpLog, DatabaseLog } from '@prisma/client';
import {
  HttpRequestAction,
  DbQueryAction,
  StepExecution,
} from '@dokkimi/config';

const TIMESTAMP_BUFFER_MS = 500;

export function stepTimeWindow(stepExecution: StepExecution): {
  startTime: Date;
  endTime: Date;
} {
  const startTime = new Date(stepExecution.startTime);
  startTime.setTime(startTime.getTime() - TIMESTAMP_BUFFER_MS);
  const endTime = new Date(stepExecution.endTime);
  endTime.setTime(endTime.getTime() + TIMESTAMP_BUFFER_MS);
  return { startTime, endTime };
}

@Injectable()
export class LogFinderService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Matches a user-provided URL against a log's target (hostname/service) and url (path).
   * URL format: "service-name/path" — splits on first slash.
   * If only a service name (no slash), matches target only.
   * If starts with "/" (path only), matches url only.
   */
  matchUrl(
    matchUrl: string,
    logTarget: string | null,
    logUrl: string,
  ): boolean {
    if (!matchUrl) {
      return true;
    }
    if (matchUrl.startsWith('/')) {
      return logUrl.includes(matchUrl);
    }

    const slashIdx = matchUrl.indexOf('/');
    const service = slashIdx >= 0 ? matchUrl.substring(0, slashIdx) : matchUrl;
    const path = slashIdx >= 0 ? matchUrl.substring(slashIdx) : '';

    if (service && logTarget !== service) {
      return false;
    }
    if (path && !logUrl.includes(path)) {
      return false;
    }

    return true;
  }

  /**
   * Finds the direct request log (test-agent's request).
   * Matches by: time range, method, target (service), and path.
   */
  findDirectRequestLog(
    httpLogs: HttpLog[],
    action: HttpRequestAction,
    stepExecution: StepExecution,
  ): HttpLog | undefined {
    const { startTime, endTime } = stepTimeWindow(stepExecution);

    const candidates = httpLogs.filter((log) => {
      const logTime = new Date(log.timestamp);
      if (logTime < startTime || logTime > endTime) {
        return false;
      }

      if (log.method !== action.method) {
        return false;
      }

      if (action.url) {
        const slashIdx = action.url.indexOf('/');
        const service =
          slashIdx >= 0 ? action.url.substring(0, slashIdx) : action.url;
        const path = slashIdx >= 0 ? action.url.substring(slashIdx) : '';

        if (service && log.target !== service) {
          return false;
        }
        if (path && !log.url.includes(path)) {
          return false;
        }
      }

      return true;
    });

    if (candidates.length <= 1) {
      return candidates[0];
    }

    const mid =
      (new Date(stepExecution.startTime).getTime() +
        new Date(stepExecution.endTime).getTime()) /
      2;
    candidates.sort(
      (a, b) =>
        Math.abs(a.timestamp.getTime() - mid) -
        Math.abs(b.timestamp.getTime() - mid),
    );
    return candidates[0];
  }

  /**
   * Finds the direct database log for a dbQuery action.
   * Matches by: instanceId, databaseName, query text, and time window.
   */
  async findDirectDatabaseLog(
    instanceId: string,
    action: DbQueryAction,
    stepExecution: StepExecution,
  ): Promise<DatabaseLog | null> {
    const { startTime, endTime } = stepTimeWindow(stepExecution);

    const candidates = await this.prisma.databaseLog.findMany({
      where: {
        instanceId,
        databaseName: action.database,
        query: action.query.trim(),
        timestamp: {
          gte: startTime,
          lte: endTime,
        },
      },
    });

    if (candidates.length === 0) {
      return null;
    }

    // Pick the candidate closest to the step execution midpoint.
    const mid =
      (new Date(stepExecution.startTime).getTime() +
        new Date(stepExecution.endTime).getTime()) /
      2;
    candidates.sort(
      (a, b) =>
        Math.abs(a.timestamp.getTime() - mid) -
        Math.abs(b.timestamp.getTime() - mid),
    );
    return candidates[0];
  }
}
