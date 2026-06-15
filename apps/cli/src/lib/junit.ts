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
  lines.push(
    `  <testsuite name="${escapeXml(opts.runId)}" tests="${totalTests}" failures="${failures}" errors="0" skipped="${skipped}" time="${durationSec}" timestamp="${timestamp}">`,
  );

  for (const inst of instances) {
    const displayStatus = inst.testStatus ?? inst.status;
    const assertions = assertionsByInstance.get(inst.id) ?? [];
    const failedAssertions = assertions.filter(
      (a) => !a.passed && a.assertionType !== 'skip',
    );
    const isFailed =
      failedAssertions.length > 0 || displayStatus === 'FAILED';

    lines.push(
      `    <testcase name="${escapeXml(inst.name)}" classname="${escapeXml(inst.name)}">`,
    );

    if (isFailed) {
      const failureBody = formatInstanceFailure(inst, failedAssertions);
      const message =
        failedAssertions.length > 0
          ? `${failedAssertions.length} assertion(s) failed`
          : (inst.errorMessage ?? 'Test failed');
      lines.push(
        `      <failure message="${escapeXml(message)}">${escapeXml(failureBody)}</failure>`,
      );
    } else if (displayStatus === 'SKIPPED') {
      lines.push('      <skipped/>');
    }

    lines.push('    </testcase>');
  }

  lines.push('  </testsuite>');
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

export async function generateSummaryMarkdown(
  opts: JUnitOptions,
): Promise<string> {
  const { ctUrl, instances, durationMs } = opts;

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

  const passed = instances.filter(
    (i) => (i.testStatus ?? i.status) === 'PASSED',
  ).length;
  const failed = instances.filter(
    (i) => (i.testStatus ?? i.status) === 'FAILED',
  ).length;
  const skipped = instances.filter(
    (i) => (i.testStatus ?? i.status) === 'SKIPPED',
  ).length;
  const durationSec = Math.round(durationMs / 1000);

  const lines: string[] = [];

  const status = failed > 0 ? 'FAILED' : 'PASSED';
  const icon = failed > 0 ? ':x:' : ':white_check_mark:';
  lines.push(`## ${icon} Dokkimi Test Results`);
  lines.push('');
  lines.push(
    `**${instances.length}** tests | **${passed}** passed | **${failed}** failed | **${skipped}** skipped | **${durationSec}s**`,
  );
  lines.push('');

  if (failed > 0) {
    lines.push('### Failed Tests');
    lines.push('');
    for (const inst of instances) {
      const displayStatus = inst.testStatus ?? inst.status;
      if (displayStatus !== 'FAILED') continue;

      const assertions = assertionsByInstance.get(inst.id) ?? [];
      const failedAssertions = assertions.filter(
        (a) => !a.passed && a.assertionType !== 'skip',
      );

      lines.push(`<details><summary>:x: ${inst.name}</summary>`);
      lines.push('');
      if (failedAssertions.length > 0) {
        lines.push('```');
        lines.push(formatInstanceFailure(inst, failedAssertions));
        lines.push('```');
      } else if (inst.errorMessage) {
        lines.push('```');
        lines.push(inst.errorMessage);
        lines.push('```');
      }
      lines.push('</details>');
      lines.push('');
    }
  }

  if (passed > 0) {
    lines.push('<details><summary>Passed tests</summary>');
    lines.push('');
    for (const inst of instances) {
      const displayStatus = inst.testStatus ?? inst.status;
      if (displayStatus === 'PASSED') {
        lines.push(`:white_check_mark: ${inst.name}`);
      }
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  return lines.join('\n');
}

function formatInstanceFailure(
  inst: RunStatusInstance,
  failedAssertions: AssertionResult[],
): string {
  if (failedAssertions.length === 0) {
    return inst.errorMessage ?? 'Test failed';
  }
  return failedAssertions
    .map((a) => {
      const parts: string[] = [];
      const name = [a.assertionType, a.path && `at ${a.path}`]
        .filter(Boolean)
        .join(' ');
      parts.push(name);
      if (a.error) {
        parts.push(`  ${a.error}`);
      } else {
        const op = a.operator ?? 'equals';
        parts.push(`  expected: ${formatValue(a.expected)}`);
        parts.push(`  actual:   ${formatValue(a.actual)}`);
        parts.push(`  operator: ${op}`);
      }
      return parts.join('\n');
    })
    .join('\n\n');
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
