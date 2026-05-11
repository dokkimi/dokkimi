import { AssertionBlock, StepExecution } from '@dokkimi/config';
import { HttpLog } from '@prisma/client';
import {
  AssertionResult,
  validateAssertion,
  validateCount,
} from '../assertion-engine';
import { DocumentAssemblerService } from '../document-assembler.service';
import { LogFinderService } from '../log-finder.service';
import { stepTimeWindow } from '../log-finder.service';

export function validateHttpCallBlock(
  block: AssertionBlock,
  stepExecution: StepExecution,
  httpLogs: HttpLog[],
  logFinder: LogFinderService,
  documentAssembler: DocumentAssemblerService,
): AssertionResult[] {
  const results: AssertionResult[] = [];

  // Filter logs by match criteria within timestamp window
  const { startTime, endTime } = stepTimeWindow(stepExecution);

  const matchingLogs = httpLogs.filter((log) => {
    const logTime = new Date(log.requestSentAt || log.timestamp);
    if (logTime < startTime || logTime > endTime) {
      return false;
    }

    if (block.match?.origin && log.origin !== block.match.origin) {
      return false;
    }
    if (block.match?.method && log.method !== block.match.method) {
      return false;
    }
    if (block.match?.url) {
      if (!logFinder.matchUrl(block.match.url, log.target, log.url)) {
        return false;
      }
    }

    return true;
  });

  // Validate count
  const count = block.count || { operator: 'gte' as const, value: 1 };
  const countResult = validateCount(matchingLogs.length, count);
  countResult.resultKind = 'count';
  results.push(countResult);
  if (!countResult.passed) {
    return results;
  }

  // Filter out disabled assertions, then check if any remain
  const activeAssertions = (block.assertions || []).filter((a) => !a.disabled);
  if (activeAssertions.length === 0) {
    return results;
  }

  // Assemble documents for each matching log
  const docs = matchingLogs.map((log) =>
    documentAssembler.assembleHttpDocument(log),
  );

  // Validate nested assertions based on assertionScope
  const scope = block.assertionScope || 'all';
  const docsToValidate =
    scope === 'first'
      ? docs.slice(0, 1)
      : scope === 'last'
        ? docs.slice(-1)
        : docs;

  if (scope === 'any') {
    // At least one log must pass ALL nested assertions
    for (const assertion of activeAssertions) {
      let anyPassed = false;
      for (const doc of docsToValidate) {
        const result = validateAssertion(assertion, doc);
        if (result.passed) {
          anyPassed = true;
          break;
        }
      }
      results.push(
        anyPassed
          ? {
              passed: true,
              path: assertion.path,
              operator: assertion.operator,
              resultKind: 'field',
            }
          : {
              passed: false,
              error: `No matching log passed assertion: ${assertion.path}`,
              path: assertion.path,
              operator: assertion.operator,
              resultKind: 'field',
            },
      );
    }
  } else {
    // All logs in scope must pass each assertion
    for (const assertion of activeAssertions) {
      for (const doc of docsToValidate) {
        const result = validateAssertion(assertion, doc);
        result.path = assertion.path;
        result.operator = assertion.operator;
        result.resultKind = 'field';
        results.push(result);
        if (!result.passed) {
          return results;
        }
      }
    }
  }

  return results;
}
