import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DUMP_PATH = path.join(os.homedir(), '.dokkimi', 'generated', 'dump.json');

export interface DumpOutput {
  runId: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  instances: DumpInstance[];
}

export interface DumpInstance {
  name: string;
  status: string;
  testStatus: string | null;
  errorMessage: string | null;
  definition: { name: string; items: unknown[]; tests?: unknown[] } | null;
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

export function reportDumpResults(
  controller: vscode.TestController,
  run: vscode.TestRun,
): void {
  let raw: string;
  try {
    raw = fs.readFileSync(DUMP_PATH, 'utf-8');
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
      const message = buildFailureMessage(instance);
      run.failed(testItem, message);
      testItem.children.forEach((child) => run.failed(child, message));
    } else if (status === 'SKIPPED') {
      run.skipped(testItem);
      testItem.children.forEach((child) => run.skipped(child));
    }
  }
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
