import * as fs from 'fs';
import * as path from 'path';
import { fetchJson } from './cli-utils';
import type { RunStatusInstance } from './run-display';
import type { AssertionResult } from './inspect-types';

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface JUnitOptions {
  ctUrl: string;
  runId: string;
  instances: RunStatusInstance[];
  durationMs: number;
  timestamp?: string;
}

export async function generateJUnitXml(opts: JUnitOptions): Promise<string> {
  const { ctUrl, instances, durationMs } = opts;
  const timestamp = opts.timestamp ?? new Date().toISOString();

  const assertionsByInstance = new Map<string, AssertionResult[]>();
  await Promise.all(
    instances
      .filter((inst) => !inst.id.startsWith('skipped-'))
      .map(async (inst) => {
        try {
          const results = await fetchJson<AssertionResult[]>(
            `${ctUrl}/logs/assertion-results/instance/${inst.id}`,
          );
          if (results && results.length > 0) {
            assertionsByInstance.set(inst.id, results);
          }
        } catch {}
      }),
  );

  const totalTests = instances.length;
  const failures = instances.filter(
    (i) => (i.testStatus ?? i.status) === 'FAILED',
  ).length;
  const skipped = instances.filter(
    (i) => (i.testStatus ?? i.status) === 'SKIPPED',
  ).length;
  const durationSec = (durationMs / 1000).toFixed(3);

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<testsuites tests="${totalTests}" failures="${failures}" errors="0" skipped="${skipped}" time="${durationSec}">`,
  );

  for (const inst of instances) {
    const displayStatus = inst.testStatus ?? inst.status;
    const assertions = assertionsByInstance.get(inst.id) ?? [];
    const failedAssertions = assertions.filter(
      (a) => !a.passed && a.assertionType !== 'skip',
    );

    const testCount = assertions.length > 0 ? assertions.length : 1;
    const failCount =
      failedAssertions.length > 0
        ? failedAssertions.length
        : displayStatus === 'FAILED'
          ? 1
          : 0;
    const skipCount = displayStatus === 'SKIPPED' ? 1 : 0;

    lines.push(
      `  <testsuite name="${escapeXml(inst.name)}" tests="${testCount}" failures="${failCount}" errors="0" skipped="${skipCount}" time="${durationSec}" timestamp="${timestamp}">`,
    );

    if (assertions.length > 0) {
      for (const a of assertions) {
        const caseName = formatAssertionName(a);
        lines.push(
          `    <testcase name="${escapeXml(caseName)}" classname="${escapeXml(inst.name)}" time="0">`,
        );
        if (!a.passed && a.assertionType !== 'skip') {
          const message = formatFailureMessage(a);
          lines.push(
            `      <failure message="${escapeXml(message)}">${escapeXml(formatFailureBody(a))}</failure>`,
          );
        }
        lines.push('    </testcase>');
      }
    } else {
      lines.push(
        `    <testcase name="${escapeXml(inst.name)}" classname="${escapeXml(inst.name)}" time="0">`,
      );
      if (displayStatus === 'FAILED') {
        const message = inst.errorMessage ?? 'Test failed';
        lines.push(`      <failure message="${escapeXml(message)}"></failure>`);
      } else if (displayStatus === 'SKIPPED') {
        lines.push('      <skipped/>');
      }
      lines.push('    </testcase>');
    }

    lines.push('  </testsuite>');
  }

  lines.push('</testsuites>');
  lines.push('');

  return lines.join('\n');
}

export async function writeJUnitXml(
  opts: JUnitOptions & { outputPath: string },
): Promise<void> {
  const xml = await generateJUnitXml(opts);
  const resolved = path.resolve(opts.outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, xml, 'utf-8');
}

function formatAssertionName(a: AssertionResult): string {
  const parts = [a.assertionType];
  if (a.path) {
    parts.push(`at ${a.path}`);
  }
  if (a.operator && a.operator !== 'equals') {
    parts.push(`(${a.operator})`);
  }
  return parts.join(' ');
}

function formatFailureMessage(a: AssertionResult): string {
  if (a.error) {
    return a.error;
  }
  const op = a.operator ?? 'equals';
  return `Expected ${formatValue(a.expected)} ${op} ${formatValue(a.actual)}`;
}

function formatFailureBody(a: AssertionResult): string {
  const lines: string[] = [];
  if (a.error) {
    lines.push(a.error);
  }
  lines.push(`expected: ${formatValue(a.expected)}`);
  lines.push(`actual:   ${formatValue(a.actual)}`);
  if (a.path) {
    lines.push(`path:     ${a.path}`);
  }
  if (a.operator) {
    lines.push(`operator: ${a.operator}`);
  }
  return lines.join('\n');
}

function formatValue(val: unknown): string {
  if (val === null || val === undefined) {
    return String(val);
  }
  if (typeof val === 'string') {
    return val;
  }
  return JSON.stringify(val);
}
