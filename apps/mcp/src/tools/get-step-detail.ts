import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ctFetch } from '../lib/ct-client';
import type {
  AssertionResult,
  TestExecutionLog,
  PaginatedResponse,
} from '../lib/ct-types';

export function registerGetStepDetail(server: McpServer): void {
  server.tool(
    'get_step_detail',
    'Returns detailed execution logs and assertion results for a specific test step. Use this to understand why a particular step failed — what happened during execution, what was asserted, and what the actual vs expected values were.',
    {
      instanceId: z
        .string()
        .describe('Instance ID (from get_run_summary or get_failures)'),
      stepIndex: z
        .number()
        .int()
        .min(0)
        .describe('Zero-based step index (from get_failures)'),
    },
    async ({ instanceId, stepIndex }) => {
      const [execLogs, assertions] = await Promise.all([
        ctFetch<PaginatedResponse<TestExecutionLog>>(
          `/logs/test-execution/instance/${instanceId}`,
        ),
        ctFetch<AssertionResult[]>(
          `/logs/assertion-results/instance/${instanceId}`,
        ),
      ]);

      const stepExecLogs = execLogs.logs.filter(
        (l) => l.stepIndex === stepIndex,
      );
      const stepAssertions = assertions.filter(
        (a) => a.stepIndex === stepIndex,
      );

      const result = {
        stepIndex,
        executionLogs: stepExecLogs.map((l) => ({
          eventType: l.eventType,
          message: l.message,
          actionType: l.actionType,
          selector: l.selector,
          duration: l.duration,
          error: l.error,
          errorType: l.errorType,
          variables: l.variables,
          timestamp: l.timestamp,
        })),
        assertions: stepAssertions.map((a) => ({
          blockIndex: a.blockIndex,
          assertionIndex: a.assertionIndex,
          passed: a.passed,
          path: a.path,
          operator: a.operator,
          expected: a.expected,
          actual: a.actual,
          error: a.error,
          resultKind: a.resultKind,
        })),
      };

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );
}
