import * as fs from 'fs';
import * as path from 'path';
import { fetchJson } from './cli-utils';
import type { RunStatusInstance } from './run-display';
import type { AssertionResult } from './inspect-types';
import { outcomeOf, type RunOutcome } from './outcome';

// Characters XML 1.0 doesn't allow, even escaped. Before, a control
// character in a log or message made the whole report unreadable.
// eslint-disable-next-line no-control-regex
const XML_ILLEGAL = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g;

function escapeXml(str: string): string {
  return str
    .replace(XML_ILLEGAL, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface JUnitOptions {
  ctUrl: string;
  /** null when no run started (every definition invalid, or none found) */
  runId: string | null;
  runStatus: string;
  instances: RunStatusInstance[];
  durationMs: number;
  timestamp?: string;
}

/** Why a definition that didn't pass or fail its test is an error */
const ERROR_MESSAGES: Record<
  Exclude<RunOutcome, 'passed' | 'failed'>,
  string
> = {
  cancelled: 'Cancelled',
  'not-run': 'Never ran',
  running: 'Did not finish',
  invalid: 'Invalid definition',
};

async function fetchAssertions(
  opts: JUnitOptions,
): Promise<Map<string, AssertionResult[]>> {
  const assertionsByInstance = new Map<string, AssertionResult[]>();
  await Promise.all(
    opts.instances
      .filter((inst) => outcomeOf(opts.runStatus, inst) !== 'invalid')
      .map(async (inst) => {
        try {
          const results = await fetchJson<AssertionResult[]>(
            `${opts.ctUrl}/logs/assertion-results/instance/${inst.id}`,
          );
          if (results && results.length > 0) {
            assertionsByInstance.set(inst.id, results);
          }
        } catch {}
      }),
  );
  return assertionsByInstance;
}

/**
 * Before, only a definition whose test failed was reported: a timed-out,
 * stopped, cancelled or never-run one counted as passed, and an invalid one
 * was dropped or skipped. Now anything that didn't pass is a failure (its
 * test failed) or an error (it didn't get a result).
 */
export async function generateJUnitXml(opts: JUnitOptions): Promise<string> {
  const { ctUrl, instances, durationMs, runStatus } = opts;
  const timestamp = opts.timestamp ?? new Date().toISOString();
  const assertionsByInstance = await fetchAssertions(opts);

  const outcomes = instances.map((i) => outcomeOf(runStatus, i));
  const totalTests = instances.length;
  const failures = outcomes.filter((o) => o === 'failed').length;
  const errors = outcomes.filter(
    (o) => o !== 'passed' && o !== 'failed',
  ).length;
  const durationSec = (durationMs / 1000).toFixed(3);
  const suiteName = escapeXml(opts.runId ?? 'dokkimi');
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<testsuites tests="${totalTests}" failures="${failures}" errors="${errors}" skipped="0" time="${durationSec}">`,
  );
  lines.push(
    `  <testsuite name="${suiteName}" tests="${totalTests}" failures="${failures}" errors="${errors}" skipped="0" time="${durationSec}" timestamp="${timestamp}">`,
  );

  for (const [index, inst] of instances.entries()) {
    const outcome = outcomes[index];
    const assertions = assertionsByInstance.get(inst.id) ?? [];
    const failedAssertions = assertions.filter(
      (a) => !a.passed && a.assertionType !== 'skip',
    );

    const timeSec = instanceDurationSec(inst);
    const timeAttr = timeSec !== null ? ` time="${timeSec.toFixed(3)}"` : '';
    lines.push(
      `    <testcase name="${escapeXml(inst.name)}" classname="${escapeXml(inst.name)}"${timeAttr}>`,
    );

    if (outcome === 'failed') {
      const failureBody = await formatInstanceFailure(
        ctUrl,
        inst,
        failedAssertions,
      );
      const message =
        failedAssertions.length > 0
          ? `${failedAssertions.length} assertion(s) failed`
          : (inst.errorMessage ?? 'Test failed');
      lines.push(
        `      <failure message="${escapeXml(message)}">${escapeXml(failureBody)}</failure>`,
      );
    } else if (outcome !== 'passed') {
      const message = ERROR_MESSAGES[outcome];
      lines.push(
        `      <error message="${escapeXml(message)}">${escapeXml(inst.errorMessage ?? message)}</error>`,
      );
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
  const { ctUrl, instances, durationMs, runStatus } = opts;
  const assertionsByInstance = await fetchAssertions(opts);

  const testcases: ParsedTestCase[] = await Promise.all(
    instances.map(async (inst) => {
      const outcome = outcomeOf(runStatus, inst);
      const dur = instanceDurationSec(inst) ?? undefined;
      if (outcome === 'passed') {
        return { name: inst.name, status: 'PASSED' as const, durationSec: dur };
      }
      if (outcome !== 'failed') {
        const message = ERROR_MESSAGES[outcome];
        return {
          name: inst.name,
          status: 'ERROR' as const,
          durationSec: dur,
          failureMessage: message,
          failureBody: inst.errorMessage ?? message,
        };
      }
      const failedAssertions = (assertionsByInstance.get(inst.id) ?? []).filter(
        (a) => !a.passed && a.assertionType !== 'skip',
      );
      return {
        name: inst.name,
        status: 'FAILED' as const,
        durationSec: dur,
        failureMessage:
          failedAssertions.length > 0
            ? `${failedAssertions.length} assertion(s) failed`
            : (inst.errorMessage ?? 'Test failed'),
        failureBody: await formatInstanceFailure(ctUrl, inst, failedAssertions),
      };
    }),
  );

  return buildSummaryMarkdown([
    {
      name: opts.runId ?? 'dokkimi',
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
  status: 'PASSED' | 'FAILED' | 'ERROR' | 'SKIPPED';
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
    const errorMatch = block.match(
      /<error\s+message="([^"]*)">([\s\S]*?)<\/error>/,
    );

    if (failureMatch) {
      testcases.push({
        name,
        status: 'FAILED',
        durationSec: durationTc,
        failureMessage: unescapeXml(failureMatch[1]),
        failureBody: unescapeXml(failureMatch[2]),
      });
    } else if (errorMatch) {
      testcases.push({
        name,
        status: 'ERROR',
        durationSec: durationTc,
        failureMessage: unescapeXml(errorMatch[1]),
        failureBody: unescapeXml(errorMatch[2]),
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
    const { testcases, durationSec } = parseJUnitXml(xml);
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
    case 'ERROR':
      return ':warning:';
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
  const errors = allTestcases.filter((t) => t.status === 'ERROR').length;
  const skipped = allTestcases.filter((t) => t.status === 'SKIPPED').length;

  const lines: string[] = [];

  lines.push(COMMENT_MARKER);
  const icon = failed + errors > 0 ? ':x:' : ':white_check_mark:';
  lines.push(`### ${icon} Dokkimi Test Results`);
  lines.push('');
  lines.push('| Tests | Passed | Failed | Errors | Skipped | Duration |');
  lines.push('|-------|--------|--------|--------|---------|----------|');
  lines.push(
    `| ${allTestcases.length} | ${passed} | ${failed} | ${errors} | ${skipped} | ${totalDuration}s |`,
  );
  lines.push('');

  if (failed + errors > 0) {
    lines.push('#### Failed Tests');
    lines.push('');
    for (const group of groups) {
      const failedTcs = group.testcases.filter(
        (t) => t.status === 'FAILED' || t.status === 'ERROR',
      );
      for (const tc of failedTcs) {
        lines.push(
          `<details open><summary>${statusIcon(tc.status)} ${group.name} / ${tc.name}</summary>`,
        );
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
  }

  lines.push('<details><summary>All tests</summary>');
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
  }

  lines.push('</details>');
  lines.push('');

  return lines.join('\n');
}

interface ConsoleLogEntry {
  level: string;
  message: string;
  timestamp: string;
}

interface TestExecutionLogEntry {
  eventType: string;
  message: string;
  stepIndex: number | null;
  error: string | null;
  errorType: string | null;
  timestamp: string;
}

interface PaginatedLogs<T> {
  logs: T[];
  total: number;
}

async function formatInstanceFailure(
  ctUrl: string,
  inst: RunStatusInstance,
  failedAssertions: AssertionResult[],
): Promise<string> {
  if (failedAssertions.length > 0) {
    return formatAssertionFailures(failedAssertions);
  }

  const sections: string[] = [];

  if (inst.errorMessage) {
    sections.push(inst.errorMessage);
  }

  try {
    const [execResult, consoleResult] = await Promise.all([
      fetchJson<PaginatedLogs<TestExecutionLogEntry>>(
        `${ctUrl}/logs/test-execution/instance/${inst.id}?limit=50`,
      ),
      fetchJson<PaginatedLogs<ConsoleLogEntry>>(
        `${ctUrl}/logs/console/instance/${inst.id}?limit=50`,
      ),
    ]);

    const execLogs = execResult?.logs ?? [];
    const errorExecLogs = execLogs.filter((l) => l.error);
    if (errorExecLogs.length > 0) {
      sections.push(
        '--- Test Execution Errors ---',
        ...errorExecLogs.map(
          (l) =>
            `[step ${l.stepIndex ?? '?'}] ${l.message}${l.error ? `\n  ${l.error}` : ''}`,
        ),
      );
    }

    const consoleLogs = consoleResult?.logs ?? [];
    const errorConsoleLogs = consoleLogs.filter(
      (l) => l.level === 'ERROR' || l.level === 'WARN',
    );
    if (errorConsoleLogs.length > 0) {
      const shown = errorConsoleLogs.slice(-20);
      sections.push(
        '--- Console Errors ---',
        ...shown.map((l) => `[${l.level}] ${l.message}`),
      );
    }
  } catch {}

  return sections.length > 0 ? sections.join('\n') : 'Test failed';
}

function formatAssertionFailures(failedAssertions: AssertionResult[]): string {
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
