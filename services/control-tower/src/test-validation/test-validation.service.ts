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
                'Step was not executed — a previous step failed before reaching this step',
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
      finalPassed = true;
      await this.updateTestStatus(
        instance.id,
        TestStatus.PASSED,
        'All assertions passed',
      );
    }

    this.telemetry.track('tvs_validation_completed', {
      module: 'test-validation',
      duration_ms: Date.now() - validationStart,
      result: finalPassed ? 'PASSED' : 'FAILED',
      test_count: testDefinitions?.length ?? 0,
    });

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
