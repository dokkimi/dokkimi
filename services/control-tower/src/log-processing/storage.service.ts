import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { HttpLogMessage, ConsoleLogMessage } from '../types/messages';
import { DatabaseLogMessageDto } from './dto/database-log-message.dto';
import { TestExecutionLogMessageDto } from './dto/test-execution-log-message.dto';
import { TestValidationLogMessageDto } from './dto/test-validation-log-message.dto';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Stores an HTTP log
   */
  async storeHttpLog(message: HttpLogMessage): Promise<string> {
    try {
      const httpLog = await this.prisma.httpLog.create({
        data: {
          instanceId: message.instanceId,
          instanceItemId: message.instanceItemId ?? null,
          method: message.method,
          url: message.url,
          statusCode: message.statusCode ?? null,
          requestBody: message.requestBody ?? undefined,
          responseBody: message.responseBody ?? undefined,
          requestHeaders: (message.requestHeaders ??
            undefined) as Prisma.InputJsonValue,
          responseHeaders: (message.responseHeaders ??
            undefined) as Prisma.InputJsonValue,
          isMocked: message.isMocked ?? null,
          timestamp: message.timestamp
            ? new Date(message.timestamp)
            : new Date(),
          origin: message.origin ?? null,
          target: message.target ?? null,
          targetId: message.targetId ?? null,
          requestSentAt: message.requestSentAt
            ? new Date(message.requestSentAt)
            : null,
          responseReceivedAt: message.responseReceivedAt
            ? new Date(message.responseReceivedAt)
            : null,
        },
      });

      this.logger.log(
        `Stored HTTP log: ${httpLog.id} for instance ${message.instanceId}`,
      );
      return httpLog.id;
    } catch (error) {
      this.logger.error(`Error storing HTTP log:`, error);
      throw error;
    }
  }

  /**
   * Stores a console log
   */
  async storeConsoleLog(message: ConsoleLogMessage): Promise<string> {
    try {
      const consoleLog = await this.prisma.consoleLog.create({
        data: {
          instanceId: message.instanceId,
          instanceItemId: message.instanceItemId ?? null,
          level: message.level,
          message: message.message,
          timestamp: message.timestamp
            ? new Date(message.timestamp)
            : new Date(),
        },
      });

      this.logger.log(
        `Stored console log: ${consoleLog.id} for instance ${message.instanceId}`,
      );
      return consoleLog.id;
    } catch (error) {
      this.logger.error(`Error storing console log:`, error);
      throw error;
    }
  }

  /**
   * Stores a database log
   */
  async storeDatabaseLog(message: DatabaseLogMessageDto): Promise<string> {
    try {
      // Normalize database type (postgres -> postgresql, mariadb -> mysql)
      let normalizedType = message.databaseType.toLowerCase();
      if (normalizedType === 'postgres') {
        normalizedType = 'postgresql';
      } else if (normalizedType === 'mariadb') {
        normalizedType = 'mysql';
      }

      // Explicitly handle data serialization to ensure it's stored correctly
      let dataValue: Prisma.InputJsonValue | undefined = undefined;
      if (message.data !== undefined && message.data !== null) {
        dataValue = message.data as Prisma.InputJsonValue;
      }

      const databaseLog = await this.prisma.databaseLog.create({
        data: {
          instanceId: message.instanceId,
          instanceItemId: message.instanceItemId ?? null,
          databaseType: normalizedType,
          databaseName: message.databaseName,
          query: message.query,
          params: (message.params ?? undefined) as Prisma.InputJsonValue,
          success: message.success,
          data: dataValue,
          rowsAffected: message.rowsAffected ?? null,
          error: message.error ?? null,
          duration: message.duration ?? null,
          timestamp: message.timestamp
            ? new Date(message.timestamp)
            : new Date(),
        },
      });

      this.logger.log(
        `Stored database log: ${databaseLog.id} for instance ${message.instanceId}`,
      );
      return databaseLog.id;
    } catch (error) {
      this.logger.error(`Error storing database log:`, error);
      throw error;
    }
  }

  /**
   * Stores a test execution log
   */
  async storeTestExecutionLog(
    message: TestExecutionLogMessageDto,
  ): Promise<string> {
    try {
      const testExecutionLog = await this.prisma.testExecutionLog.create({
        data: {
          instanceId: message.instanceId,
          eventType: message.eventType,
          message: message.message,
          stepIndex: message.stepIndex ?? null,
          subActionIndex: message.subActionIndex ?? null,
          subStepIndex: message.subStepIndex ?? null,
          actionType: message.actionType ?? null,
          selector: message.selector ?? null,
          duration: message.duration ?? null,
          error: message.error ?? null,
          errorType: message.errorType ?? null,
          variables: message.variables ?? {},
          timestamp: message.timestamp
            ? new Date(message.timestamp)
            : new Date(),
        },
      });

      this.logger.log(
        `Stored test execution log: ${testExecutionLog.id} for instance ${message.instanceId} (eventType: ${message.eventType})`,
      );
      return testExecutionLog.id;
    } catch (error) {
      this.logger.error(`Error storing test execution log:`, error);
      throw error;
    }
  }

  /**
   * Stores inline validation results from the test-agent
   */
  async storeTestValidationResults(
    message: TestValidationLogMessageDto,
  ): Promise<void> {
    try {
      const data = message.assertions.map((a, index) => ({
        instanceId: message.instanceId,
        stepIndex: message.stepIndex,
        assertionIndex: index,
        assertionType: a.resultKind ?? 'field',
        passed: a.passed,
        expected: a.expected as Prisma.InputJsonValue,
        actual: a.actual as Prisma.InputJsonValue,
        error: a.error ?? null,
        path: a.path ?? null,
        operator: a.operator ?? null,
        blockIndex: a.blockIndex ?? null,
        resultKind: a.resultKind ?? null,
      }));

      await this.prisma.assertionResult.createMany({ data });

      this.logger.log(
        `Stored ${data.length} assertion results for instance ${message.instanceId} step ${message.stepIndex}`,
      );
    } catch (error) {
      this.logger.error(`Error storing test validation results:`, error);
      throw error;
    }
  }
}
