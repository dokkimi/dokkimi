import path from 'path';
import fs from 'fs';
import os from 'os';
import { DokkimiConfig } from '@dokkimi/config';
import { execSilent, isCommandAvailable, startDocker } from '@dokkimi/platform';

const SERVICE_ID = 'control-tower';

interface HealthResponse {
  status: string;
  service?: string;
}

export async function checkHealth(
  url: string,
): Promise<{ healthy: boolean; detail?: string }> {
  try {
    const res = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      return { healthy: false, detail: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as HealthResponse;
    if (body.service && body.service !== SERVICE_ID) {
      return { healthy: false, detail: `wrong service: ${body.service}` };
    }
    return { healthy: true };
  } catch {
    return { healthy: false, detail: 'not reachable' };
  }
}

function isDockerRunning(): boolean {
  try {
    execSilent('docker info', { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function ensureDockerRunning(
  timeoutMs: number = 120000,
  signal?: AbortSignal,
): Promise<void> {
  if (!isCommandAvailable('docker')) {
    throw new Error(
      'Docker is not installed. Install Docker Desktop from https://www.docker.com/products/docker-desktop/',
    );
  }

  if (isDockerRunning()) {
    return;
  }

  console.log('[Dokkimi] Docker is not running. Starting Docker...');
  startDocker();

  const deadline = Date.now() + timeoutMs;
  let pollCount = 0;

  while (Date.now() < deadline) {
    signal?.throwIfAborted();

    if (isDockerRunning()) {
      console.log('[Dokkimi] Docker is ready.');
      return;
    }

    pollCount++;
    if (pollCount % 5 === 0) {
      const elapsed = Math.round((Date.now() - (deadline - timeoutMs)) / 1000);
      console.log(`[Dokkimi] Waiting for Docker... (${elapsed}s elapsed)`);
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(
    'Timed out waiting for Docker to start. Please start Docker Desktop manually.',
  );
}

export function runPrismaMigrate(appRoot: string, config: DokkimiConfig): void {
  const schemaPath = path.join(
    appRoot,
    'shared',
    'prisma',
    'sqlite',
    'schema.prisma',
  );
  const configPath = path.join(appRoot, 'shared', 'prisma', 'prisma.config.ts');
  if (!fs.existsSync(schemaPath)) {
    console.warn(
      `[Dokkimi] Skipping database migration: schema not found at ${schemaPath}`,
    );
    return;
  }
  if (!fs.existsSync(configPath)) {
    console.warn(
      `[Dokkimi] Skipping database migration: prisma.config.ts not found at ${configPath}. ` +
        `Prisma v7 requires this file to supply the datasource URL.`,
    );
    return;
  }

  const dbUrl = config.database.url.replace(/^file:~/, `file:${os.homedir()}`);

  const localPrisma = path.join(appRoot, 'node_modules', '.bin', 'prisma');
  const prismaBin = fs.existsSync(localPrisma)
    ? `"${localPrisma}"`
    : 'npx prisma';

  try {
    execSilent(`${prismaBin} migrate deploy --config="${configPath}"`, {
      cwd: appRoot,
      env: { ...process.env, DATABASE_URL: dbUrl },
      timeout: 120000,
    });
  } catch (err) {
    const execErr = err as {
      message?: string;
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };
    const stderr = execErr.stderr?.toString().trim() ?? '';
    const stdout = execErr.stdout?.toString().trim() ?? '';
    const detail = stderr || stdout || execErr.message || String(err);
    console.warn(
      `[Dokkimi] Database migration failed — Control Tower will likely fail health checks.\n` +
        `  Schema: ${schemaPath}\n` +
        `  DATABASE_URL: ${dbUrl}\n` +
        `  Prisma binary: ${prismaBin}\n` +
        `  Error:\n${detail
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n')}`,
    );
  }
}
