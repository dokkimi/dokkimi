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
    const isFailed = failedAssertions.length > 0 || displayStatus === 'FAILED';

    const timeSec = instanceDurationSec(inst);
    const timeAttr = timeSec !== null ? ` time="${timeSec.toFixed(3)}"` : '';
    lines.push(
      `    <testcase name="${escapeXml(inst.name)}" classname="${escapeXml(inst.name)}"${timeAttr}>`,
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

  const testcases: ParsedTestCase[] = instances.map((inst) => {
    const displayStatus = inst.testStatus ?? inst.status;
    const assertions = assertionsByInstance.get(inst.id) ?? [];
    const failedAssertions = assertions.filter(
      (a) => !a.passed && a.assertionType !== 'skip',
    );
    const isFailed = failedAssertions.length > 0 || displayStatus === 'FAILED';

    const dur = instanceDurationSec(inst) ?? undefined;

    if (isFailed) {
      return {
        name: inst.name,
        status: 'FAILED' as const,
        durationSec: dur,
        failureMessage:
          failedAssertions.length > 0
            ? `${failedAssertions.length} assertion(s) failed`
            : (inst.errorMessage ?? 'Test failed'),
        failureBody: formatInstanceFailure(inst, failedAssertions),
      };
    } else if (displayStatus === 'SKIPPED') {
      return { name: inst.name, status: 'SKIPPED' as const, durationSec: dur };
    }
    return { name: inst.name, status: 'PASSED' as const, durationSec: dur };
  });

  return buildSummaryMarkdown([
    {
      name: opts.runId,
      testcases,
      durationSec: Math.round(durationMs / 1000),
    },
  ]);
}

function instanceDurationSec(inst: RunStatusInstance): number | null {
  if (!inst.startedAt || !inst.stoppedAt) {
    return null;
  }
  return (
    (new Date(inst.stoppedAt).getTime() - new Date(inst.startedAt).getTime()) /
    1000
  );
}

interface ParsedTestCase {
  name: string;
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
  durationSec?: number;
  failureMessage?: string;
  failureBody?: string;
}

interface ParsedTestGroup {
  name: string;
  testcases: ParsedTestCase[];
  durationSec: number;
}

function parseXmlAttr(tag: string, attr: string): string {
  const match = tag.match(new RegExp(`${attr}="([^"]*)"`));
  return match ? match[1] : '';
}

function unescapeXml(str: string): string {
  return str
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function parseJUnitXml(xml: string): {
  testcases: ParsedTestCase[];
  durationSec: number;
  suiteName: string;
} {
  const testcases: ParsedTestCase[] = [];

  const suitesMatch = xml.match(/<testsuites[^>]*>/);
  const durationSec = suitesMatch
    ? parseFloat(parseXmlAttr(suitesMatch[0], 'time')) || 0
    : 0;

  const suiteMatch = xml.match(/<testsuite\b(?!s)[^>]*>/);
  const suiteName = suiteMatch
    ? unescapeXml(parseXmlAttr(suiteMatch[0], 'name'))
    : '';

  const testcaseRegex =
    /<testcase\s[^>]*>[\s\S]*?<\/testcase>|<testcase\s[^>]*\/>/g;
  let match;
  while ((match = testcaseRegex.exec(xml)) !== null) {
    const block = match[0];
    const nameTag = block.match(/<testcase\s[^>]*/);
    const name = nameTag ? unescapeXml(parseXmlAttr(nameTag[0], 'name')) : '';

    const timeStr = nameTag ? parseXmlAttr(nameTag[0], 'time') : '';
    const durationTc = timeStr ? parseFloat(timeStr) : undefined;

    const failureMatch = block.match(
      /<failure\s+message="([^"]*)">([\s\S]*?)<\/failure>/,
    );
    const skippedMatch = block.match(/<skipped\s*\/>/);

    if (failureMatch) {
      testcases.push({
        name,
        status: 'FAILED',
        durationSec: durationTc,
        failureMessage: unescapeXml(failureMatch[1]),
        failureBody: unescapeXml(failureMatch[2]),
      });
    } else if (skippedMatch) {
      testcases.push({ name, status: 'SKIPPED', durationSec: durationTc });
    } else {
      testcases.push({ name, status: 'PASSED', durationSec: durationTc });
    }
  }

  return { testcases, durationSec, suiteName };
}

export function generateSummaryFromXmlDir(dirPath: string): string {
  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved)) {
    return '';
  }

  const files = fs
    .readdirSync(resolved)
    .filter((f) => f.endsWith('.xml'))
    .sort();
  if (files.length === 0) {
    return '';
  }

  const groups: ParsedTestGroup[] = [];
  for (const file of files) {
    const xml = fs.readFileSync(path.join(resolved, file), 'utf-8');
    const { testcases, durationSec, suiteName } = parseJUnitXml(xml);
    const name = file.replace(/\.xml$/, '');
    groups.push({ name, testcases, durationSec });
  }

  return buildSummaryMarkdown(groups);
}

const COMMENT_MARKER = '<!-- dokkimi-test-results -->';

function statusIcon(status: ParsedTestCase['status']): string {
  switch (status) {
    case 'PASSED':
      return ':white_check_mark:';
    case 'FAILED':
      return ':x:';
    case 'SKIPPED':
      return ':fast_forward:';
  }
}

function buildSummaryMarkdown(groups: ParsedTestGroup[]): string {
  const allTestcases = groups.flatMap((g) => g.testcases);
  const totalDuration = Math.round(
    groups.reduce((sum, g) => sum + g.durationSec, 0),
  );
  const passed = allTestcases.filter((t) => t.status === 'PASSED').length;
  const failed = allTestcases.filter((t) => t.status === 'FAILED').length;
  const skipped = allTestcases.filter((t) => t.status === 'SKIPPED').length;

  const lines: string[] = [];

  lines.push(COMMENT_MARKER);
  const icon = failed > 0 ? ':x:' : ':white_check_mark:';
  lines.push(`### ${icon} Dokkimi Test Results`);
  lines.push('');
  lines.push('| Tests | Passed | Failed | Skipped | Duration |');
  lines.push('|-------|--------|--------|---------|----------|');
  lines.push(
    `| ${allTestcases.length} | ${passed} | ${failed} | ${skipped} | ${totalDuration}s |`,
  );
  lines.push('');

  lines.push('<details><summary>Details</summary>');
  lines.push('');

  for (const group of groups) {
    const dur = Math.round(group.durationSec);
    lines.push(`#### ${group.name} (${dur}s)`);
    lines.push('');
    lines.push('| | Test | Duration |');
    lines.push('|---|------|----------|');
    for (const tc of group.testcases) {
      const durStr =
        tc.durationSec != null ? `${Math.round(tc.durationSec)}s` : '-';
      lines.push(`| ${statusIcon(tc.status)} | ${tc.name} | ${durStr} |`);
    }
    lines.push('');

    const failedTcs = group.testcases.filter((t) => t.status === 'FAILED');
    for (const tc of failedTcs) {
      lines.push(`<details><summary>:x: ${tc.name}</summary>`);
      lines.push('');
      if (tc.failureBody) {
        lines.push('```');
        lines.push(tc.failureBody);
        lines.push('```');
      } else if (tc.failureMessage) {
        lines.push('```');
        lines.push(tc.failureMessage);
        lines.push('```');
      }
      lines.push('</details>');
      lines.push('');
    }
  }

  lines.push('</details>');
  lines.push('');

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
