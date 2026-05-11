import { Injectable } from '@nestjs/common';
import { ColoredLoggerService } from '../logging/colored-logger.service';
import { HttpLog } from '@prisma/client';
import { VariableContextService } from './variable-context.service';
import { AssertionBlock, StepExecution, ActionTestStep } from '@dokkimi/config';
import { AssertionResult, resolveExtractRule } from './assertion-engine';
import { DocumentAssemblerService } from './document-assembler.service';
import { LogFinderService } from './log-finder.service';
import { ConsoleLogBlockValidatorService } from './block-validators/console-log-block-validator.service';
import { validateSelfBlock } from './block-validators/self-block-validator';
import { validateHttpCallBlock } from './block-validators/http-call-block-validator';

export type { AssertionResult } from './assertion-engine';

@Injectable()
export class AssertionValidatorService {
  constructor(
    private readonly logger: ColoredLoggerService,
    private readonly variableContext: VariableContextService,
    private readonly documentAssembler: DocumentAssemblerService,
    private readonly logFinder: LogFinderService,
    private readonly consoleLogValidator: ConsoleLogBlockValidatorService,
  ) {}

  /**
   * Validates all assertion blocks for a test step.
   *
   * Processing order per assertion block:
   * 1. Extract variables from block.extract (to populate variables for subsequent assertions/steps)
   * 2. Validate the block's assertions
   */
  async validateAssertions(
    instanceId: string,
    step: ActionTestStep,
    stepIndex: number,
    stepExecution: StepExecution,
    httpLogs: HttpLog[],
  ): Promise<AssertionResult[]> {
    const results: AssertionResult[] = [];

    // Assemble the document for the step's own action (used for self-block and extract)
    const doc = await this.documentAssembler.assembleStepDocument(
      instanceId,
      step,
      stepIndex,
      stepExecution,
      httpLogs,
    );

    // Build extract document — extract paths follow test-agent's convention
    // (flat: body, statusCode, headers) not TVS assertion convention (response.body, etc.)
    const extractDoc = await this.documentAssembler.assembleExtractDocument(
      instanceId,
      step,
      stepIndex,
      stepExecution,
      httpLogs,
    );

    // Process step-level extract (variables available to subsequent steps)
    if (step.extract) {
      for (const [variable, rule] of Object.entries(step.extract)) {
        try {
          const value = resolveExtractRule(extractDoc, variable, rule);
          this.variableContext.set(variable, value);
          const rulePath = typeof rule === 'string' ? rule : rule.path;
          results.push({ passed: true, path: rulePath, resultKind: 'extract' });
        } catch (error) {
          const rulePath = typeof rule === 'string' ? rule : rule.path;
          results.push({
            passed: false,
            error: error instanceof Error ? error.message : String(error),
            path: rulePath,
            resultKind: 'extract',
          });
        }
      }
    }

    // Propagate UI-action sub-step extracts into CT's variable context so subsequent
    // steps can reference them in `{{var}}` placeholders.
    if ((step.action as { type?: string }).type === 'ui') {
      const uiExtracted = (doc.extracted ?? {}) as Record<string, unknown>;
      for (const [name, value] of Object.entries(uiExtracted)) {
        this.variableContext.set(name, String(value));
      }
    }

    if (!step.assertions || step.assertions.length === 0) {
      return results;
    }

    // Process per-block extract + validate
    for (
      let blockIndex = 0;
      blockIndex < step.assertions.length;
      blockIndex++
    ) {
      const block = step.assertions[blockIndex];

      // Process per-assertion extract rules against the assembled document
      if (block.extract) {
        for (const [variable, rule] of Object.entries(block.extract)) {
          try {
            const value = resolveExtractRule(doc, variable, rule);
            this.variableContext.set(variable, value);
            const rulePath = typeof rule === 'string' ? rule : rule.path;
            results.push({
              passed: true,
              path: rulePath,
              blockIndex,
              resultKind: 'extract',
            });
          } catch (error) {
            const rulePath = typeof rule === 'string' ? rule : rule.path;
            results.push({
              passed: false,
              error: error instanceof Error ? error.message : String(error),
              path: rulePath,
              blockIndex,
              resultKind: 'extract',
            });
          }
        }
      }

      try {
        const blockResults = await this.validateBlock(
          instanceId,
          block,
          stepExecution,
          httpLogs,
          doc,
        );
        for (const r of blockResults) {
          r.blockIndex = blockIndex;
        }
        results.push(...blockResults);
      } catch (error) {
        results.push({
          passed: false,
          error: error instanceof Error ? error.message : String(error),
          blockIndex,
        });
      }
    }

    return results;
  }

  private async validateBlock(
    instanceId: string,
    block: AssertionBlock,
    stepExecution: StepExecution,
    httpLogs: HttpLog[],
    stepDoc: Record<string, any>,
  ): Promise<AssertionResult[]> {
    if (block.service && block.consoleAssertions) {
      return this.consoleLogValidator.validateConsoleLogBlock(
        instanceId,
        block,
        stepExecution,
      );
    }
    if (block.match) {
      return validateHttpCallBlock(
        block,
        stepExecution,
        httpLogs,
        this.logFinder,
        this.documentAssembler,
      );
    }
    return validateSelfBlock(block, stepDoc);
  }
}
