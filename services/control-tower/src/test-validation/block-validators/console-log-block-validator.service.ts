import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AssertionBlock,
  ConsoleLogAssertion,
  StepExecution,
} from '@dokkimi/config';
import { AssertionResult, validateCount } from '../assertion-engine';
import { stepTimeWindow } from '../log-finder.service';

const CONSOLE_LOG_RETRY_COUNT = 3;
const CONSOLE_LOG_RETRY_DELAY_MS = 1000;

@Injectable()
export class ConsoleLogBlockValidatorService {
  private readonly logger = new Logger(ConsoleLogBlockValidatorService.name);

  constructor(private readonly prisma: PrismaService) {}

  async validateConsoleLogBlock(
    instanceId: string,
    block: AssertionBlock,
    stepExecution: StepExecution,
  ): Promise<AssertionResult[]> {
    // Resolve service to instanceItemId
    const instanceItem = await this.prisma.instanceItem.findFirst({
      where: {
        instanceId,
        itemDefinitionName: block.service!,
      },
      select: { id: true },
    });

    const { startTime, endTime } = stepTimeWindow(stepExecution);
    const assertions = (block.consoleAssertions || []).filter(
      (a) => !a.disabled,
    );

    // Console logs arrive via Fluent Bit which flushes on a 1s interval.
    // Retry when any assertion that expects logs to exist fails, to allow
    // time for in-flight logs to be ingested.
    for (let attempt = 0; attempt <= CONSOLE_LOG_RETRY_COUNT; attempt++) {
      const results = await this.evaluateAssertions(
        instanceId,
        assertions,
        instanceItem?.id ?? null,
        startTime,
        endTime,
      );

      const allPassed = results.every((r) => r.passed);
      if (allPassed || attempt === CONSOLE_LOG_RETRY_COUNT) {
        return results;
      }

      const anyExpectsLogs = results.some(
        (r) => !r.passed && r.expected != null && r.expected > 0,
      );
      if (!anyExpectsLogs) {
        return results;
      }

      this.logger.log(
        `Console log assertions not yet satisfied for instance ${instanceId}, retrying (${attempt + 1}/${CONSOLE_LOG_RETRY_COUNT})`,
      );
      await new Promise((resolve) =>
        setTimeout(resolve, CONSOLE_LOG_RETRY_DELAY_MS),
      );
    }

    // Unreachable, but satisfies the compiler
    return [];
  }

  private async evaluateAssertions(
    instanceId: string,
    assertions: ConsoleLogAssertion[],
    instanceItemId: string | null,
    startTime: Date,
    endTime: Date,
  ): Promise<AssertionResult[]> {
    const results: AssertionResult[] = [];
    for (const assertion of assertions) {
      const result = await this.validateConsoleLogAssertion(
        instanceId,
        assertion,
        instanceItemId,
        startTime,
        endTime,
      );
      const parts: string[] = [];
      if (assertion.level) {
        parts.push(assertion.level.toUpperCase());
      }
      if (assertion.message) {
        parts.push(
          `${assertion.message.operator} "${assertion.message.value}"`,
        );
      }
      result.path = `console(${parts.join(', ')})`;
      result.resultKind = 'count';
      results.push(result);
    }
    return results;
  }

  private async validateConsoleLogAssertion(
    instanceId: string,
    assertion: ConsoleLogAssertion,
    instanceItemId: string | null,
    startTime: Date,
    endTime: Date,
  ): Promise<AssertionResult> {
    const where: any = {
      instanceId,
      timestamp: {
        gte: startTime,
        lte: endTime,
      },
    };

    if (instanceItemId) {
      where.instanceItemId = instanceItemId;
    }

    if (assertion.level) {
      where.level = assertion.level.toUpperCase();
    }

    let matchingLogs = await this.prisma.consoleLog.findMany({
      where,
      orderBy: { timestamp: 'asc' },
    });

    // Filter by message if provided
    if (assertion.message) {
      const { operator, value } = assertion.message;
      matchingLogs = matchingLogs.filter((log) => {
        switch (operator) {
          case 'eq':
            return log.message === value;
          case 'contains':
            return log.message.includes(value);
          case 'matches':
            try {
              return new RegExp(value).test(log.message);
            } catch {
              return false;
            }
          default:
            return false;
        }
      });
    }

    return validateCount(matchingLogs.length, assertion.count);
  }
}
