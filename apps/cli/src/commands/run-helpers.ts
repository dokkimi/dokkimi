import * as path from 'path';
import { type ResolvedDefinition } from '@dokkimi/definition-resolver';
import { fetchPostWithError } from '../lib/cli-utils';
import { trackEvent } from '@dokkimi/telemetry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateRunResponse {
  runId: string;
  instances: Array<{ id: string; name: string; status: string }>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function definitionHasUiSteps(def: ResolvedDefinition): boolean {
  const tests = (def.definition as Record<string, unknown>).tests;
  if (!Array.isArray(tests)) {
    return false;
  }
  for (const test of tests) {
    const steps = (test as Record<string, unknown>).steps;
    if (!Array.isArray(steps)) {
      continue;
    }
    for (const step of steps) {
      const action = (step as Record<string, unknown>)?.action as
        | Record<string, unknown>
        | undefined;
      if (action?.type === 'ui') {
        return true;
      }
    }
  }
  return false;
}

export function detectTargetType(target: string | undefined): string {
  if (!target) {
    return 'none';
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs');
  try {
    const absTarget = path.resolve(target);
    if (fs.existsSync(absTarget) && fs.statSync(absTarget).isDirectory()) {
      return 'directory';
    }
  } catch {}
  if (
    target.endsWith('.json') ||
    target.endsWith('.yml') ||
    target.endsWith('.yaml')
  ) {
    return 'file';
  }
  return 'pattern';
}

export function trackRunError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  let errorType = 'unknown';
  let failedServices: string[] | undefined;

  if (msg.includes('Docker is not installed')) {
    errorType = 'docker_not_installed';
  } else if (msg.includes('Timed out waiting for Docker')) {
    errorType = 'docker_start_timeout';
  } else if (msg.includes('Timed out waiting for Dokkimi')) {
    errorType = 'service_start_timeout';
    failedServices = ['dokkimi'];
  } else if (msg.includes('daemon.lock')) {
    errorType = 'daemon_lock_timeout';
  }

  trackEvent('cli_service_error', {
    error_type: errorType,
    ...(failedServices ? { failed_services: failedServices } : {}),
  });
}

// ---------------------------------------------------------------------------
// Submit a resolved definition to CT
// ---------------------------------------------------------------------------

export async function submitDefinition(
  ctUrl: string,
  runId: string,
  instanceId: string,
  def: ResolvedDefinition,
): Promise<string | null> {
  const body = buildSubmitBody(def);
  const result = await fetchPostWithError(
    `${ctUrl}/runs/${runId}/instances/${instanceId}`,
    body,
  );
  return result.error ?? null;
}

export function buildSubmitBody(
  def: ResolvedDefinition,
): Record<string, unknown> {
  const initFilesByItem = new Map<
    string,
    Array<{ filename: string; content: string }>
  >();
  for (const initFile of def.initFiles) {
    const bucket = initFilesByItem.get(initFile.itemName) ?? [];
    bucket.push({
      filename: initFile.filename,
      content: initFile.content.toString('base64'),
    });
    initFilesByItem.set(initFile.itemName, bucket);
  }

  const mountFilesByItem = new Map<
    string,
    Array<{ source: string; target: string; content: string }>
  >();
  for (const mf of def.mountFiles) {
    const bucket = mountFilesByItem.get(mf.itemName) ?? [];
    bucket.push({
      source: mf.source,
      target: mf.target,
      content: mf.content.toString('base64'),
    });
    mountFilesByItem.set(mf.itemName, bucket);
  }

  const items = (def.definition.items as Array<Record<string, unknown>>).map(
    (item) => {
      const { initFilePath, initFilePaths, mountFiles, ...rest } = item;
      void initFilePath;
      void initFilePaths;
      void mountFiles;

      if (Array.isArray(rest.env)) {
        const envObj: Record<string, string> = {};
        for (const entry of rest.env as Array<{
          name: string;
          value: string;
        }>) {
          if (entry && typeof entry.name === 'string') {
            envObj[entry.name] = String(entry.value ?? '');
          }
        }
        rest.env = envObj;
      }

      const initFiles = initFilesByItem.get(rest.name as string);
      if (initFiles) {
        (rest as Record<string, unknown>).initFiles = initFiles;
      }
      const mFiles = mountFilesByItem.get(rest.name as string);
      if (mFiles) {
        (rest as Record<string, unknown>).mountFiles = mFiles;
      }
      return rest;
    },
  );

  return {
    definition: {
      ...def.definition,
      items,
    },
  };
}
