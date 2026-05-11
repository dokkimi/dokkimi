import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ColoredLoggerService } from '../logging/colored-logger.service';
import { Prisma } from '@prisma/client';
import {
  AssertionValidatorService,
  type AssertionResult,
} from './assertion-validator.service';
import { VariableContextService } from './variable-context.service';
import { formatAssertionMessage } from './assertion-result-formatter';
import { StepExecution, TestDefinition, ActionTestStep } from '@dokkimi/config';

export interface StepValidationTelemetry {
  assertionCount: number;
  passedAssertionCount: number;
  failedAssertionCount: number;
  skippedStepCount: number;
  stoppedOnFailure: boolean;
  hasExtract: boolean;
  assertionTypeCounts: {
    self: number;
    httpCall: number;
    consoleLog: number;
  };
  totalStepCount: number;
}

@Injectable()
export class StepValidatorService {
  constructor(
    private readonly logger: ColoredLoggerService,
    private readonly prisma: PrismaService,
    private readonly assertionValidator: AssertionValidatorService,
    private readonly variableContext: VariableContextService,
  ) {}

  async validateTestAssertions(
    instanceId: string,
    testDefinitions: TestDefinition[],
    stepExecutions: StepExecution[],
    partial?: boolean,
    definitionVariables?: Record<string, string>,
  ): Promise<{
    passed: boolean;
    error?: string;
    telemetry?: StepValidationTelemetry;
  }> {
    this.logger.log(`Starting assertion validation for instance ${instanceId}`);

    const allSteps: {
      testName: string;
      testIndex: number;
      step: ActionTestStep;
      stopOnFailure: boolean;
    }[] = [];
    for (let ti = 0; ti < testDefinitions.length; ti++) {
      const test = testDefinitions[ti];
      for (const step of test.steps || []) {
        allSteps.push({
          testName: test.name,
          testIndex: ti,
          step,
          stopOnFailure: test.stopOnFailure !== false,
        });
      }
    }

    this.logger.log(
      `Test definitions have ${allSteps.length} steps, received ${stepExecutions.length} step executions`,
    );

    this.variableContext.clear();

    if (definitionVariables) {
      for (const [name, value] of Object.entries(definitionVariables)) {
        this.variableContext.set(name, value);
      }
    }

    for (const test of testDefinitions) {
      if (test.variables) {
        for (const [name, value] of Object.entries(test.variables)) {
          this.variableContext.set(name, value);
        }
      }
    }

    let allPassed = true;
    const errors: string[] = [];

    let assertionCount = 0;
    let passedAssertionCount = 0;
    let failedAssertionCount = 0;
    let skippedStepCount = 0;
    let stoppedOnFailure = false;
    let hasExtract = false;
    const assertionTypeCounts = { self: 0, httpCall: 0, consoleLog: 0 };

    const totalStepCount = allSteps.length;
    for (const s of allSteps) {
      if ((s.step as any).extract) {
        hasExtract = true;
      }
    }

    for (let stepIndex = 0; stepIndex < allSteps.length; stepIndex++) {
      const {
        step,
        stopOnFailure: stopOnFail,
        testIndex,
      } = allSteps[stepIndex];
      const stepLabel = `Step ${testIndex + 1}.${stepIndex + 1}`;
      const stepExecution = stepExecutions.find(
        (s) => s.stepIndex === stepIndex,
      );

      if (!stepExecution) {
        if (partial) {
          continue;
        }

        this.logger.warn(
          `No step execution found for step ${stepIndex}, marking as SKIPPED`,
        );

        skippedStepCount++;
        await this.writeNonPassResult(
          instanceId,
          stepIndex,
          'SKIPPED',
          'Step was not executed — a prior step failed',
        );

        try {
          await this.prisma.testExecutionLog.create({
            data: {
              instanceId,
              eventType: 'REQUEST_SKIPPED',
              message: `Step ${stepIndex} skipped — no execution data (prior failure)`,
              stepIndex,
            },
          });
        } catch (error) {
          this.logger.warn(
            `Failed to log step skip: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        continue;
      }

      const TIMESTAMP_BUFFER_MS = 100;
      const startTime = new Date(stepExecution.startTime);
      startTime.setTime(startTime.getTime() - TIMESTAMP_BUFFER_MS);
      const endTime = new Date(stepExecution.endTime);
      endTime.setTime(endTime.getTime() + TIMESTAMP_BUFFER_MS);

      const stepLogs = await this.prisma.httpLog.findMany({
        where: {
          instanceId,
          requestSentAt: {
            gte: startTime,
            lte: endTime,
          },
        },
        orderBy: { requestSentAt: 'asc' },
      });

      this.logger.log(
        `Step ${stepIndex}: Found ${stepLogs.length} HttpLogs in window ${startTime.toISOString()} - ${endTime.toISOString()}`,
      );
      for (const log of stepLogs) {
        this.logger.log(
          `  HttpLog: ${log.origin || '(none)'} → ${log.target} [${log.method} ${log.url}] requestSentAt=${log.requestSentAt}`,
        );
      }

      this.logger.log(
        `${stepLabel}: Validating ${step.name || step.action.type}`,
      );

      let resolvedStep: any;
      try {
        resolvedStep = this.variableContext.resolveObject(step);
      } catch (error) {
        allPassed = false;
        errors.push(
          `${stepLabel}: Variable resolution failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (stopOnFail) {
          stoppedOnFailure = true;
          this.writeSkippedRemaining(instanceId, allSteps, stepIndex);
          break;
        }
        continue;
      }

      const blockCount = resolvedStep.assertions?.length ?? 0;

      try {
        await this.prisma.testExecutionLog.create({
          data: {
            instanceId,
            eventType: 'ASSERTION_VALIDATION_STARTED',
            message: `Starting assertion validation for ${stepLabel} (${blockCount} assertion block${blockCount !== 1 ? 's' : ''})`,
            stepIndex,
          },
        });
      } catch (error) {
        this.logger.warn(
          `Failed to log assertion validation started: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // eslint-disable-next-line no-useless-assignment -- used after the try/catch
      let assertionResults: AssertionResult[] = [];
      try {
        assertionResults = await this.assertionValidator.validateAssertions(
          instanceId,
          resolvedStep,
          stepIndex,
          stepExecution,
          stepLogs,
        );
      } catch (error) {
        allPassed = false;
        errors.push(
          `${stepLabel}: Assertion validation error: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (stopOnFail) {
          stoppedOnFailure = true;
          this.writeSkippedRemaining(instanceId, allSteps, stepIndex);
          break;
        }
        continue;
      }

      for (
        let assertionIndex = 0;
        assertionIndex < assertionResults.length;
        assertionIndex++
      ) {
        const result = assertionResults[assertionIndex];

        const block = resolvedStep.assertions?.[result.blockIndex ?? 0];
        const assertionType = block?.service
          ? 'consoleLog'
          : block?.match
            ? 'httpCall'
            : 'self';

        assertionCount++;
        if (result.passed) {
          passedAssertionCount++;
        } else {
          failedAssertionCount++;
        }
        if (assertionType === 'self') {
          assertionTypeCounts.self++;
        } else if (assertionType === 'httpCall') {
          assertionTypeCounts.httpCall++;
        } else if (assertionType === 'consoleLog') {
          assertionTypeCounts.consoleLog++;
        }

        const message = formatAssertionMessage(result);
        const passedStr = result.passed ? '✓ PASSED' : '✗ FAILED';
        this.logger.log(`  ${message} (${passedStr})`);
        if (!result.passed) {
          this.logger.log(
            `    Expected: ${JSON.stringify(result.expected)}, Actual: ${JSON.stringify(result.actual)}${result.error ? `, Error: ${result.error}` : ''}`,
          );
        }

        try {
          await this.prisma.assertionResult.create({
            data: {
              instanceId,
              stepIndex,
              assertionIndex,
              assertionType,
              passed: result.passed,
              expected: result.expected
                ? (result.expected as Prisma.InputJsonValue)
                : undefined,
              actual: result.actual
                ? (result.actual as Prisma.InputJsonValue)
                : undefined,
              error: result.error || null,
              path: result.path || null,
              operator: result.operator || null,
              blockIndex: result.blockIndex ?? null,
              resultKind: result.resultKind || null,
            },
          });

          await this.prisma.testExecutionLog.create({
            data: {
              instanceId,
              eventType: result.passed
                ? 'ASSERTION_PASSED'
                : 'ASSERTION_FAILED',
              message,
              stepIndex,
              error: result.error || null,
            },
          });
        } catch (error) {
          this.logger.warn(
            `Failed to store assertion result: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        if (!result.passed) {
          allPassed = false;
          if (result.error) {
            errors.push(
              `${stepLabel}, Assertion ${assertionIndex}: ${result.error}`,
            );
          } else {
            errors.push(
              `${stepLabel}, Assertion ${assertionIndex}: Expected ${JSON.stringify(result.expected)}, got ${JSON.stringify(result.actual)}`,
            );
          }
        }
      }

      try {
        await this.prisma.testExecutionLog.create({
          data: {
            instanceId,
            eventType: 'ASSERTION_VALIDATION_COMPLETE',
            message: `Assertion validation complete for ${stepLabel}: ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`,
            stepIndex,
          },
        });
      } catch (error) {
        this.logger.warn(
          `Failed to log assertion validation complete: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (!allPassed && stopOnFail) {
        stoppedOnFailure = true;
        for (let si = stepIndex + 1; si < allSteps.length; si++) {
          skippedStepCount++;
          await this.writeNonPassResult(
            instanceId,
            si,
            'NOT_VALIDATED',
            'Step was not validated — a prior step failed assertion validation',
          );
          try {
            await this.prisma.testExecutionLog.create({
              data: {
                instanceId,
                eventType: 'REQUEST_SKIPPED',
                message: `Step ${si} skipped — assertion failure in prior step`,
                stepIndex: si,
              },
            });
          } catch (error) {
            this.logger.warn(
              `Failed to log step skip: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        break;
      }
    }

    this.logger.log(
      `Assertion validation complete: ${allPassed ? 'ALL PASSED' : 'FAILED'}`,
    );
    if (!allPassed) {
      this.logger.log(`Errors: ${errors.join('; ')}`);
    }

    return {
      passed: allPassed,
      error: errors.length > 0 ? errors.join('; ') : undefined,
      telemetry: {
        assertionCount,
        passedAssertionCount,
        failedAssertionCount,
        skippedStepCount,
        stoppedOnFailure,
        hasExtract,
        assertionTypeCounts,
        totalStepCount,
      },
    };
  }

  private async writeSkippedRemaining(
    instanceId: string,
    allSteps: { step: ActionTestStep }[],
    currentIndex: number,
  ): Promise<void> {
    for (let si = currentIndex + 1; si < allSteps.length; si++) {
      await this.writeNonPassResult(
        instanceId,
        si,
        'NOT_VALIDATED',
        'Step was not validated — a prior step failed',
      );
    }
  }

  private async writeNonPassResult(
    instanceId: string,
    stepIndex: number,
    resultKind: 'SKIPPED' | 'NOT_VALIDATED',
    error: string,
  ): Promise<void> {
    try {
      await this.prisma.assertionResult.create({
        data: {
          instanceId,
          stepIndex,
          assertionIndex: 0,
          assertionType: 'skip',
          passed: false,
          resultKind,
          error,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to store ${resultKind} assertion result: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
