import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HttpLog } from '@prisma/client';
import { LogFinderService } from './log-finder.service';
import {
  ActionTestStep,
  StepExecution,
  HttpRequestAction,
  DbQueryAction,
} from '@dokkimi/config';

export function normalizeHeaderKeys(headers: any): Record<string, any> {
  if (!headers || typeof headers !== 'object') {
    return {};
  }
  const normalized: Record<string, any> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

@Injectable()
export class DocumentAssemblerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logFinder: LogFinderService,
  ) {}

  /**
   * Assembles a logical document for the step's own action.
   * HTTP steps → assembleHttpDocument from the direct request log
   * DB query steps → assembleDbDocument from the DatabaseLog table
   * UI steps → variables newly extracted during this UI action under `extracted`
   */
  async assembleStepDocument(
    instanceId: string,
    step: ActionTestStep,
    stepIndex: number,
    stepExecution: StepExecution,
    httpLogs: HttpLog[],
  ): Promise<Record<string, any>> {
    if (step.action.type === 'wait') {
      return {};
    }

    if (step.action.type === 'dbQuery') {
      const action = step.action as DbQueryAction;
      return this.assembleDbDocument(instanceId, action, stepExecution);
    }

    if ((step.action as { type?: string }).type === 'ui') {
      return this.assembleUiDocument(instanceId, stepIndex);
    }

    // Default: HTTP request action
    const action = step.action as HttpRequestAction;
    const directRequestLog = this.logFinder.findDirectRequestLog(
      httpLogs,
      action,
      stepExecution,
    );
    return this.assembleHttpDocument(directRequestLog ?? null);
  }

  /**
   * Assembles a document for step-level extract paths.
   * Extract paths follow test-agent's convention (flat: body, statusCode, headers)
   * rather than TVS assertion convention (response.body, response.status, etc.)
   */
  async assembleExtractDocument(
    instanceId: string,
    step: ActionTestStep,
    stepIndex: number,
    stepExecution: StepExecution,
    httpLogs: HttpLog[],
  ): Promise<Record<string, any>> {
    if (step.action.type === 'wait') {
      return {};
    }

    if (step.action.type === 'dbQuery') {
      const action = step.action as DbQueryAction;
      return this.assembleDbDocument(instanceId, action, stepExecution);
    }

    if ((step.action as { type?: string }).type === 'ui') {
      return this.assembleUiDocument(instanceId, stepIndex);
    }

    // HTTP: build flat document matching test-agent's extract format
    const action = step.action as HttpRequestAction;
    const log = this.logFinder.findDirectRequestLog(
      httpLogs,
      action,
      stepExecution,
    );
    if (!log) {
      return {};
    }

    return {
      statusCode: log.statusCode,
      headers: normalizeHeaderKeys(log.responseHeaders),
      body: log.responseBody ?? {},
    };
  }

  /**
   * Assembles a logical HTTP document from flat DB columns.
   *
   * Shape:
   * {
   *   request: { method, url, header, body },
   *   response: { status, header, body },
   *   responseTime
   * }
   */
  assembleHttpDocument(log: HttpLog | null): Record<string, any> {
    if (!log) {
      return {};
    }

    let responseTime: number | null = null;
    if (log.requestSentAt && log.responseReceivedAt) {
      responseTime =
        new Date(log.responseReceivedAt).getTime() -
        new Date(log.requestSentAt).getTime();
    }

    return {
      request: {
        method: log.method,
        url: log.url,
        header: normalizeHeaderKeys(log.requestHeaders),
        body: log.requestBody ?? {},
      },
      response: {
        status: log.statusCode,
        header: normalizeHeaderKeys(log.responseHeaders),
        body: log.responseBody ?? {},
      },
      responseTime,
    };
  }

  /**
   * Assembles a logical DB query document from the DatabaseLog table.
   *
   * Shape:
   * {
   *   success: boolean,
   *   data: any[],
   *   rowsAffected: number | null,
   *   error: string | null,
   *   duration: number | null
   * }
   */
  private async assembleDbDocument(
    instanceId: string,
    action: DbQueryAction,
    stepExecution: StepExecution,
  ): Promise<Record<string, any>> {
    const log = await this.logFinder.findDirectDatabaseLog(
      instanceId,
      action,
      stepExecution,
    );

    if (!log) {
      return {};
    }

    return {
      success: log.success,
      data: log.data ?? [],
      rowsAffected: log.rowsAffected,
      error: log.error,
      duration: log.duration,
    };
  }

  /**
   * Assembles the self-doc for a UI action by diffing the variable snapshot
   * recorded on this step's first vs last test_execution_log entry.
   */
  private async assembleUiDocument(
    instanceId: string,
    stepIndex: number,
  ): Promise<Record<string, any>> {
    const logs = await this.prisma.testExecutionLog.findMany({
      where: {
        instanceId,
        stepIndex,
        eventType: {
          in: [
            'UI_SUBSTEP_STARTED',
            'UI_SUBSTEP_COMPLETED',
            'UI_SUBSTEP_FAILED',
            'REQUEST_STARTED',
            'REQUEST_COMPLETED',
            'REQUEST_FAILED',
          ],
        },
      },
      orderBy: { timestamp: 'asc' },
      select: { variables: true },
    });
    if (logs.length === 0) {
      return {};
    }

    const initial = (logs[0].variables ?? {}) as Record<string, string>;
    const final = (logs[logs.length - 1].variables ?? {}) as Record<
      string,
      string
    >;

    const extracted: Record<string, string> = {};
    for (const [k, v] of Object.entries(final)) {
      if (!(k in initial) || initial[k] !== v) {
        extracted[k] = v;
      }
    }
    return { extracted };
  }
}
