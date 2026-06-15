import * as path from 'path';
import { fetchJson } from '../lib/cli-utils';
import { loadConfig, buildServiceUrl } from '@dokkimi/config';
import { trackEvent } from '@dokkimi/telemetry';
import {
  generateJUnitXml,
  generateSummaryMarkdown,
  writeJUnitXml,
} from '../lib/junit';
import type { LatestRunResponse } from '../lib/inspect-types';
import { getProjectPath, latestRunUrl } from '../lib/project-path';

export async function junit(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: dokkimi junit [-o <file>] [--summary] [--run [runId]] [--failed]',
    );
    console.log('');
    console.log('Generate a JUnit XML report from a test run.');
    console.log('');
    console.log('By default, outputs JUnit XML to stdout.');
    console.log('');
    console.log('Options:');
    console.log('  -o, --output <file> Write XML to a file instead of stdout');
    console.log(
      '  --summary           Output a markdown summary instead of XML',
    );
    console.log(
      '  --run [runId]       Target a specific run by ID (defaults to latest)',
    );
    console.log('  --failed            Only include instances that failed');
    process.exit(0);
  }

  const explicitOutput = parseOutputFlag(args);
  const summaryMode = parseBoolFlag(args, '--summary');
  const failedOnly = parseBoolFlag(args, '--failed');
  const runFlag = parseRunFlag(args);
  const config = loadConfig();
  const ctUrl = buildServiceUrl(config.services.controlTower);

  const selectedRun = await resolveRun(ctUrl, runFlag);
  if (!selectedRun) {
    return;
  }

  let instances = selectedRun.instances;

  if (failedOnly) {
    instances = instances.filter(
      (i) => i.testStatus === 'FAILED' || i.status === 'FAILED',
    );
    if (instances.length === 0) {
      console.error('No failed instances in the selected run.');
      process.exit(0);
    }
  }

  const durationMs =
    selectedRun.completedAt && selectedRun.createdAt
      ? new Date(selectedRun.completedAt).getTime() -
        new Date(selectedRun.createdAt).getTime()
      : 0;

  const junitOpts = {
    ctUrl,
    runId: selectedRun.runId,
    instances,
    durationMs,
  };

  if (summaryMode) {
    const md = await generateSummaryMarkdown(junitOpts);
    process.stdout.write(md);
  } else if (explicitOutput) {
    await writeJUnitXml({ ...junitOpts, outputPath: explicitOutput });
    console.error(`JUnit XML written to ${path.resolve(explicitOutput)}`);
  } else {
    const xml = await generateJUnitXml(junitOpts);
    process.stdout.write(xml);
  }

  trackEvent('cli_junit_result', {
    instance_count: instances.length,
    failed_only: failedOnly,
    output_to_file: !!explicitOutput,
    summary_mode: summaryMode,
  });
}

function parseBoolFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx === -1) {
    return false;
  }
  args.splice(idx, 1);
  return true;
}

function parseOutputFlag(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o' || args[i] === '--output') {
      const value = args[i + 1];
      if (!value || value.startsWith('-')) {
        console.error('--output requires a file path');
        process.exit(1);
      }
      args.splice(i, 2);
      return value;
    }
  }
  return null;
}

function parseRunFlag(args: string[]): string | null {
  const idx = args.indexOf('--run');
  if (idx === -1) {
    return null;
  }
  const next = args[idx + 1];
  if (!next || next.startsWith('-')) {
    args.splice(idx, 1);
    return null;
  }
  args.splice(idx, 2);
  return next;
}

async function resolveRun(
  ctUrl: string,
  runId: string | null,
): Promise<LatestRunResponse | null> {
  if (runId) {
    const run = await fetchJson<LatestRunResponse>(
      `${ctUrl}/runs/${runId}/status`,
    );
    if (!run) {
      console.error(`Run ${runId} not found.`);
      process.exit(1);
    }
    return run;
  }

  const projectPath = getProjectPath();
  const run = await fetchJson<LatestRunResponse>(
    latestRunUrl(ctUrl, projectPath),
  );
  if (!run) {
    console.error('No run history found. Run `dokkimi run` first.');
    process.exit(1);
  }
  return run;
}
