import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ColoredLoggerService } from '../logging/colored-logger.service';
import { TelemetryService } from '../telemetry/telemetry.service';
import { TestStatus } from '@prisma/client';
import { QuiescenceDetectionService } from './quiescence-detection.service';
import { LoopDetectionService } from './loop-detection.service';
import { StepValidatorService } from './step-validator.service';
import { RunStorageService } from '../storage/run-storage.service';
import { RunsService } from '../runs/runs.service';
import { VisualMatchService } from '../artifacts/visual-match.service';
import { StepExecution, TestDefinition } from '@dokkimi/config';

@Injectable()
export class TestValidationService {
  constructor(
    private readonly logger: ColoredLoggerService,
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => RunsService))
    private readonly runsService: RunsService,
    private readonly runStorage: RunStorageService,
    private readonly stepValidator: StepValidatorService,
    private readonly quiescenceDetection: QuiescenceDetectionService,
    private readonly loopDetection: LoopDetectionService,
    private readonly telemetry: TelemetryService,
    private readonly visualMatch: VisualMatchService,
  ) {}

  async processTestCompletion(
    testRunId: string,
    status: 'success' | 'failure',
    message?: string,
    stepExecutions?: StepExecution[],
    partial?: boolean,
  ): Promise<void> {
    const validationStart = Date.now();

    this.logger.log(
      `Processing test completion for testRunId: ${testRunId}, status: ${status}`,
    );

    const instance = await this.prisma.namespaceInstance.findUnique({
      where: { id: testRunId },
    });

    if (!instance) {
      this.logger.error(`Instance not found for testRunId ${testRunId}`);
      throw new Error(`Instance not found for testRunId ${testRunId}`);
    }

    let testDefinitions: TestDefinition[] | undefined;
    let definitionVariables: Record<string, string> | undefined;
    try {
      const stored = await this.runStorage.readDefinition(instance.id);
      testDefinitions = stored.tests as TestDefinition[] | undefined;
      definitionVariables = stored.variables as
        | Record<string, string>
        | undefined;
    } catch (err) {
      this.logger.warn(
        `Could not read definition.json for instance ${instance.id}: ${err instanceof Error ? err.message : err}`,
      );
    }

    const hasTestSteps =
      testDefinitions?.some(
        (t) => Array.isArray(t.steps) && t.steps.length > 0,
      ) ?? false;

    let finalPassed: boolean | undefined;
    let finalError: string | undefined;
    let validationResult:
      | { passed: boolean; error?: string; telemetry?: any }
      | undefined;

    if (status === 'failure') {
      finalPassed = false;
      finalError = message || 'Test execution failed';
      await this.updateTestStatus(instance.id, TestStatus.FAILED, finalError);

      if (testDefinitions && hasTestSteps) {
        const executedSteps = new Set(
          (stepExecutions ?? []).map((s) => s.stepIndex),
        );
        let globalStepIndex = 0;
        for (const test of testDefinitions) {
          for (const _step of test.steps ?? []) {
            if (!executedSteps.has(globalStepIndex)) {
              await this.writeNonPassResult(
                instance.id,
                globalStepIndex,
                'SKIPPED',
                'Step was not executed — test-agent failed before reaching this step',
              );
              try {
                await this.prisma.testExecutionLog.create({
                  data: {
                    instanceId: instance.id,
                    eventType: 'REQUEST_SKIPPED',
                    message: `Step ${globalStepIndex} skipped — test-agent reported failure`,
                    stepIndex: globalStepIndex,
                  },
                });
              } catch (error) {
                this.logger.warn(
                  `Failed to log step skip: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
            globalStepIndex++;
          }
        }
      }
    }

    if (status === 'success') {
      try {
        const afterTime =
          stepExecutions && stepExecutions.length > 0
            ? new Date(stepExecutions[0].startTime)
            : new Date(Date.now() - 60000);

        await this.quiescenceDetection.waitForLogsToSettle(
          testRunId,
          afterTime,
        );

        if (testDefinitions && hasTestSteps) {
          if (!stepExecutions || stepExecutions.length === 0) {
            throw new Error('stepExecutions is required for test validation');
          }

          validationResult = await this.stepValidator.validateTestAssertions(
            instance.id,
            testDefinitions,
            stepExecutions,
            partial,
            definitionVariables,
          );

          const loopResult = await this.loopDetection.detectLoops(instance.id, {
            enabled: true,
            maxCallsPerPair: 50,
            maxTotalCalls: 500,
          });

          if (loopResult.hasLoop) {
            this.telemetry.track('tvs_loop_detected', {
              module: 'test-validation',
            });
            this.logger.warn(
              `Loop detected for instance ${instance.id}: ${loopResult.reason}`,
            );
            finalPassed = false;
            finalError = `Infinite loop detected: ${loopResult.reason}`;
            await this.updateTestStatus(
              instance.id,
              TestStatus.FAILED,
              finalError,
            );
          } else if (validationResult.passed) {
            finalPassed = true;
            await this.updateTestStatus(
              instance.id,
              TestStatus.PASSED,
              'All assertions passed',
            );
          } else {
            finalPassed = false;
            finalError = validationResult.error || 'Some assertions failed';
            await this.updateTestStatus(
              instance.id,
              TestStatus.FAILED,
              finalError,
            );
          }
        } else {
          finalPassed = true;
          await this.updateTestStatus(
            instance.id,
            TestStatus.PASSED,
            testDefinitions
              ? 'No tests configured'
              : message || 'Tests completed successfully',
          );
        }
      } catch (error) {
        this.logger.error(
          `Error validating test assertions:`,
          error instanceof Error ? error.stack : String(error),
        );
        finalPassed = false;
        finalError = `Validation error: ${error instanceof Error ? error.message : String(error)}`;
        await this.updateTestStatus(instance.id, TestStatus.FAILED, finalError);
      }
    }

    let tHasVariables = !!(
      definitionVariables && Object.keys(definitionVariables).length > 0
    );
    if (testDefinitions) {
      for (const t of testDefinitions) {
        if (t.variables && Object.keys(t.variables).length > 0) {
          tHasVariables = true;
        }
      }
    }

    const vt =
      status === 'success' && hasTestSteps
        ? validationResult?.telemetry
        : undefined;

    this.telemetry.track('tvs_validation_completed', {
      module: 'test-validation',
      duration_ms: Date.now() - validationStart,
      result: finalPassed ? 'PASSED' : 'FAILED',
      test_count: testDefinitions?.length ?? 0,
      total_step_count: vt?.totalStepCount,
      assertion_count: vt?.assertionCount,
      passed_assertion_count: vt?.passedAssertionCount,
      failed_assertion_count: vt?.failedAssertionCount,
      skipped_step_count: vt?.skippedStepCount,
      assertion_types: vt?.assertionTypeCounts,
      has_variables: tHasVariables,
      has_extract: vt?.hasExtract,
      stopped_on_failure: vt?.stoppedOnFailure,
    });

    try {
      const summary = await this.visualMatch.processInstance(instance.id);
      if (summary.failures.length > 0) {
        const lines = summary.failures.map((f: any) => `  - ${f.message}`);
        const visualError =
          `Visual match check${summary.failures.length === 1 ? '' : 's'} failed:\n` +
          lines.join('\n');
        if (finalPassed === true) {
          finalPassed = false;
          finalError = visualError;
        } else {
          finalError = finalError
            ? `${finalError}\n\n${visualError}`
            : visualError;
        }
        await this.updateTestStatus(
          instance.id,
          TestStatus.FAILED,
          finalError ?? visualError,
        );
      }
    } catch (err) {
      this.logger.error(
        `visualMatch diff job failed for ${instance.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }

    try {
      await this.runsService.handleValidationComplete(
        instance.id,
        finalPassed ?? false,
        finalError,
      );
    } catch (err) {
      this.logger.error(
        `Failed to notify runs service of validation complete for ${instance.id}:`,
        err instanceof Error ? err.message : String(err),
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

  private async updateTestStatus(
    instanceId: string,
    status: TestStatus,
    message: string,
    results?: any,
  ): Promise<void> {
    await this.prisma.namespaceInstance.update({
      where: { id: instanceId },
      data: {
        testStatus: status,
        testResults: results || null,
        testCompletedAt: new Date(),
        errorMessage: status === TestStatus.FAILED ? message : null,
      },
    });

    this.logger.log(`Updated test status for ${instanceId}: ${status}`);
  }
}
