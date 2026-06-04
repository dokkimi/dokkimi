import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { projectRunsDir } from '@dokkimi/config';

export interface DumpOutput {
  runId: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  instances: DumpInstance[];
}

interface DumpTest {
  name: string;
  steps?: unknown[];
}

export interface DumpInstance {
  name: string;
  status: string;
  testStatus: string | null;
  errorMessage: string | null;
  definition: { name: string; items: unknown[]; tests?: DumpTest[] } | null;
  items: unknown[];
  testExecutionLogs: { eventType: string; message: string; error?: string }[];
  assertionResults: AssertionResult[];
  httpLogs: unknown[];
  databaseLogs: unknown[];
  consoleLogs: unknown[];
}

export interface AssertionResult {
  stepIndex: number;
  assertionIndex: number;
  assertionType: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
  path: string | null;
  operator: string | null;
  blockIndex: number;
  resultKind: string;
}

export function findLatestDumpPath(projectPath: string): string | null {
  const runsDir = projectRunsDir(projectPath);
  try {
    const entries = fs.readdirSync(runsDir).sort().reverse();
    for (const entry of entries) {
      const dumpFile = path.join(runsDir, entry, 'dump.json');
      if (fs.existsSync(dumpFile)) {
        return dumpFile;
      }
    }
  } catch {}
  return null;
}

export function reportDumpResults(
  controller: vscode.TestController,
  run: vscode.TestRun,
  dumpFilePath?: string,
): void {
  const filePath =
    dumpFilePath ??
    (() => {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      return ws ? findLatestDumpPath(ws) : null;
    })();
  if (!filePath) {
    return;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return;
  }

  let dump: DumpOutput;
  try {
    dump = JSON.parse(raw);
  } catch {
    return;
  }

  if (!dump?.instances) {
    return;
  }

  for (const instance of dump.instances) {
    const testItem = findItemByLabel(controller, instance.name);
    if (!testItem) {
      continue;
    }

    const status = instance.testStatus ?? instance.status;

    if (status === 'PASSED' || status === 'COMPLETED') {
      run.passed(testItem);
      testItem.children.forEach((child) => run.passed(child));
    } else if (status === 'FAILED') {
      const perTest = buildPerTestResults(instance);

      if (perTest.size > 0) {
        let anyChildFailed = false;
        testItem.children.forEach((child) => {
          const result = perTest.get(child.label);
          if (!result) {
            return;
          }
          if (result.status === 'passed') {
            run.passed(child);
          } else if (result.status === 'skipped') {
            run.skipped(child);
          } else {
            anyChildFailed = true;
            run.failed(child, result.message);
          }
        });
        if (anyChildFailed) {
          run.failed(testItem, buildFailureMessage(instance));
        } else {
          run.passed(testItem);
        }
      } else {
        const message = buildFailureMessage(instance);
        run.failed(testItem, message);
        testItem.children.forEach((child) => run.failed(child, message));
      }
    } else if (status === 'SKIPPED') {
      run.skipped(testItem);
      testItem.children.forEach((child) => run.skipped(child));
    }
  }
}

interface TestResult {
  status: 'passed' | 'failed' | 'skipped';
  message: vscode.TestMessage;
}

function buildPerTestResults(instance: DumpInstance): Map<string, TestResult> {
  const results = new Map<string, TestResult>();
  const tests = instance.definition?.tests;
  if (!tests || tests.length === 0) {
    return results;
  }

  // Build a map from global stepIndex to test name.
  // Steps are numbered globally: test 0 has steps 0..n-1, test 1 has steps n..n+m-1, etc.
  const stepToTest = new Map<number, string>();
  let globalIndex = 0;
  for (const test of tests) {
    const stepCount = Array.isArray(test.steps) ? test.steps.length : 0;
    for (let s = 0; s < stepCount; s++) {
      stepToTest.set(globalIndex++, test.name);
    }
  }

  // Group assertion results by test name
  const assertionsByTest = new Map<string, AssertionResult[]>();
  for (const a of instance.assertionResults) {
    const testName = stepToTest.get(a.stepIndex);
    if (!testName) {
      continue;
    }
    let list = assertionsByTest.get(testName);
    if (!list) {
      list = [];
      assertionsByTest.set(testName, list);
    }
    list.push(a);
  }

  for (const test of tests) {
    const assertions = assertionsByTest.get(test.name) ?? [];
    const allSkipped =
      assertions.length > 0 &&
      assertions.every(
        (a) => a.resultKind === 'NOT_VALIDATED' || a.resultKind === 'SKIPPED',
      );

    if (allSkipped) {
      results.set(test.name, {
        status: 'skipped',
        message: new vscode.TestMessage('Skipped — a prior test failed'),
      });
      continue;
    }

    const failed = assertions.filter(
      (a) =>
        !a.passed &&
        a.resultKind !== 'NOT_VALIDATED' &&
        a.resultKind !== 'SKIPPED',
    );
    if (failed.length === 0) {
      results.set(test.name, {
        status: 'passed',
        message: new vscode.TestMessage(''),
      });
    } else {
      const lines: string[] = [];
      for (const a of failed) {
        const loc = a.path ? ` at ${a.path}` : '';
        const op = a.operator ?? 'equals';
        lines.push(`${a.assertionType}${loc}  (${op})`);
        lines.push(`  expected: ${formatValue(a.expected)}`);
        lines.push(`  received: ${formatValue(a.actual)}`);
        lines.push('');
      }
      results.set(test.name, {
        status: 'failed',
        message: new vscode.TestMessage(lines.join('\n')),
      });
    }
  }

  return results;
}

function buildFailureMessage(instance: DumpInstance): vscode.TestMessage {
  const lines: string[] = [];

  if (instance.errorMessage) {
    lines.push(instance.errorMessage);
    lines.push('');
  }

  const failedAssertions = instance.assertionResults.filter((a) => !a.passed);
  for (const a of failedAssertions) {
    const loc = a.path ? ` at ${a.path}` : '';
    const op = a.operator ?? 'equals';
    lines.push(`${a.assertionType}${loc}  (${op})`);
    lines.push(`  expected: ${formatValue(a.expected)}`);
    lines.push(`  received: ${formatValue(a.actual)}`);
    lines.push('');
  }

  if (lines.length === 0) {
    const errorLogs = instance.testExecutionLogs.filter(
      (l) => l.eventType === 'step_error' || l.error,
    );
    for (const log of errorLogs.slice(0, 5)) {
      lines.push(log.error ?? log.message);
    }
  }

  if (lines.length === 0) {
    lines.push('Definition failed');
  }

  return new vscode.TestMessage(lines.join('\n'));
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') {
    return `"${v}"`;
  }
  return String(v);
}

export function findItemByLabel(
  controller: vscode.TestController,
  label: string,
): vscode.TestItem | undefined {
  let found: vscode.TestItem | undefined;
  controller.items.forEach((item) => {
    if (item.label === label) {
      found = item;
    }
  });
  return found;
}
