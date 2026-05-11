import * as path from 'path';
import * as os from 'os';
import { existsSync, readFileSync, statSync } from 'fs';
import { PAD_LABEL } from '../lib/cli-utils';
import { loadConfig } from '@dokkimi/config';
import { getServiceStatus } from '@dokkimi/service-manager';
import { trackEvent } from '@dokkimi/telemetry';
import {
  execSilent,
  isCommandAvailable,
  getDiskSpaceAvailable,
} from '@dokkimi/platform';

interface Check {
  name: string;
  pass: boolean;
  detail: string;
  fix?: string;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function checkCommand(
  cmd: string,
  versionFlag: string = '--version',
): { available: boolean; version: string } {
  try {
    const output = execSilent(`${cmd} ${versionFlag}`, { timeout: 5000 });
    const firstLine = output.split('\n')[0].trim();
    return { available: true, version: firstLine };
  } catch {
    return { available: false, version: '' };
  }
}

function checkDocker(): Check {
  try {
    execSilent('docker info', { timeout: 10000 });
    return { name: 'Docker', pass: true, detail: 'running' };
  } catch {
    if (isCommandAvailable('docker')) {
      return {
        name: 'Docker',
        pass: false,
        detail: 'installed but not running',
        fix: 'Start Docker Desktop',
      };
    }
    return {
      name: 'Docker',
      pass: false,
      detail: 'not installed',
      fix: 'Install Docker Desktop: https://docs.docker.com/get-docker/',
    };
  }
}

function checkDockerMemory(): Check {
  try {
    const output = execSilent('docker system info --format "{{.MemTotal}}"', {
      timeout: 10000,
    });
    const bytes = parseInt(output, 10);
    if (isNaN(bytes)) {
      return { name: 'Docker Memory', pass: true, detail: 'unable to detect' };
    }
    const gb = bytes / (1024 * 1024 * 1024);
    const rounded = Math.round(gb * 10) / 10;
    if (gb < 4) {
      return {
        name: 'Docker Memory',
        pass: false,
        detail: `${rounded} GB allocated`,
        fix: 'Docker Desktop → Settings → Resources → set Memory to at least 4 GB (6+ GB recommended)',
      };
    }
    return {
      name: 'Docker Memory',
      pass: true,
      detail: `${rounded} GB allocated`,
    };
  } catch {
    return { name: 'Docker Memory', pass: true, detail: 'unable to detect' };
  }
}

function checkKubernetes(): Check {
  if (!isCommandAvailable('kubectl')) {
    return {
      name: 'Kubernetes',
      pass: false,
      detail: 'kubectl not installed',
      fix: 'Enable Kubernetes in Docker Desktop → Settings → Kubernetes',
    };
  }

  try {
    const output = execSilent('kubectl cluster-info', { timeout: 10000 });
    if (output.includes('is running at')) {
      return { name: 'Kubernetes', pass: true, detail: 'cluster reachable' };
    }
    return {
      name: 'Kubernetes',
      pass: false,
      detail: 'cluster not reachable',
      fix: 'Enable Kubernetes in Docker Desktop → Settings → Kubernetes',
    };
  } catch {
    return {
      name: 'Kubernetes',
      pass: false,
      detail: 'cluster not reachable',
      fix: 'Enable Kubernetes in Docker Desktop → Settings → Kubernetes',
    };
  }
}

function checkKubeContext(): Check {
  try {
    const context = execSilent('kubectl config current-context', {
      timeout: 5000,
    });
    return { name: 'K8s Context', pass: true, detail: context };
  } catch {
    return { name: 'K8s Context', pass: true, detail: 'unable to detect' };
  }
}

function checkDiskSpace(): Check {
  const gb = getDiskSpaceAvailable();
  if (gb === null) {
    return { name: 'Disk Space', pass: true, detail: 'unable to detect' };
  }
  const rounded = Math.round(gb * 10) / 10;
  const label = gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${rounded} GB`;
  if (gb < 5) {
    return {
      name: 'Disk Space',
      pass: false,
      detail: `${label} available`,
      fix: 'Dokkimi needs space for Docker images and run storage. Free up at least 5 GB.',
    };
  }
  return { name: 'Disk Space', pass: true, detail: `${label} available` };
}

/**
 * Validates the local Dokkimi SQLite database by inspecting the on-disk file
 * directly — no SQLite dependency needed. We check:
 *
 *   1. The file is non-empty and begins with the SQLite magic ("SQLite format 3").
 *   2. The sqlite_master schema page (first ~128 KB covers it comfortably)
 *      contains at least one core Dokkimi table definition. If none of the
 *      app tables exist, migrations never ran — the exact failure mode we
 *      keep hitting.
 *
 * We deliberately don't check for `_prisma_migrations`: with Prisma's driver
 * adapters it isn't always present on SQLite, so the core app tables are a
 * more reliable signal.
 *
 * A missing file is fine — it'll be created on first `dokkimi run`.
 */
function checkDatabase(): Check {
  const dbPath = path.join(os.homedir(), '.dokkimi', 'dokkimi.db');
  if (!existsSync(dbPath)) {
    return {
      name: 'Database',
      pass: true,
      detail: 'not yet initialized (created on first run)',
    };
  }
  try {
    const size = statSync(dbPath).size;
    if (size === 0) {
      return {
        name: 'Database',
        pass: false,
        detail: `${dbPath} is empty — migrations never ran`,
        fix: `rm ${dbPath} && dokkimi run`,
      };
    }
    const buf = readFileSync(dbPath).subarray(0, Math.min(size, 128 * 1024));
    if (!buf.subarray(0, 15).toString('ascii').startsWith('SQLite format 3')) {
      return {
        name: 'Database',
        pass: false,
        detail: `${dbPath} is not a valid SQLite file`,
        fix: `rm ${dbPath} && dokkimi run`,
      };
    }
    // Any of these core tables existing means the schema has been applied.
    const coreTables = ['runs', 'namespace_instances', 'instance_items'];
    const hasAnyTable = coreTables.some((t) => buf.includes(Buffer.from(t)));
    if (!hasAnyTable) {
      return {
        name: 'Database',
        pass: false,
        detail: `${dbPath} exists but has no Dokkimi tables`,
        fix: `rm ${dbPath} && dokkimi run`,
      };
    }
    const kb = Math.round(size / 1024);
    const sizeLabel = kb < 1024 ? `${kb} KB` : `${(kb / 1024).toFixed(1)} MB`;
    return {
      name: 'Database',
      pass: true,
      detail: `initialized (${sizeLabel})`,
    };
  } catch (err) {
    return {
      name: 'Database',
      pass: true,
      detail: `unable to check (${err instanceof Error ? err.message : 'unknown error'})`,
    };
  }
}

async function checkDokkimiServices(): Promise<Check> {
  try {
    const config = loadConfig();
    const serviceStatus = await getServiceStatus(config);

    if (serviceStatus.healthy) {
      return { name: 'Dokkimi Services', pass: true, detail: 'all healthy' };
    }
    return {
      name: 'Dokkimi Services',
      pass: true,
      detail: 'not started (will start on next dokkimi run)',
    };
  } catch {
    return {
      name: 'Dokkimi Services',
      pass: true,
      detail: 'not started (will start on next dokkimi run)',
    };
  }
}

export async function doctor(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: dokkimi doctor');
    console.log('');
    console.log(
      'Run pre-flight checks to verify your environment is ready for Dokkimi.',
    );
    process.exit(0);
  }

  console.log('');
  console.log('Dokkimi Doctor');
  console.log('══════════════');
  console.log('');

  const checks: Check[] = [];

  // Node.js
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1), 10);
  checks.push({
    name: 'Node.js',
    pass: nodeMajor >= 20,
    detail: nodeMajor >= 20 ? nodeVersion : `${nodeVersion} (requires >= 20)`,
    fix:
      nodeMajor < 20 ? 'Install Node.js 20+: https://nodejs.org/' : undefined,
  });

  // Docker
  const dockerCheck = checkDocker();
  checks.push(dockerCheck);

  // Docker memory (only if Docker is running)
  if (dockerCheck.pass) {
    checks.push(checkDockerMemory());
  }

  // Kubernetes
  checks.push(checkKubernetes());

  // K8s context (informational)
  checks.push(checkKubeContext());

  // Disk space
  checks.push(checkDiskSpace());

  // Dokkimi database (schema + migration state)
  checks.push(checkDatabase());

  // Dokkimi services
  checks.push(await checkDokkimiServices());

  // .dokkimi/ in CWD (warning only)
  const dokkimiDir = path.join(process.cwd(), '.dokkimi');
  const hasDokkimi = existsSync(dokkimiDir);
  checks.push({
    name: '.dokkimi/',
    pass: hasDokkimi,
    detail: hasDokkimi
      ? 'found in current directory'
      : 'not found in current directory',
    fix: hasDokkimi ? undefined : "Run 'dokkimi init' to scaffold one",
  });

  // Print results
  let failures = 0;
  let warnings = 0;

  for (const check of checks) {
    if (check.pass) {
      console.log(
        `  \x1b[32m✓\x1b[0m ${check.name.padEnd(PAD_LABEL)} ${check.detail}`,
      );
    } else {
      const isWarning = check.name === '.dokkimi/';
      if (isWarning) {
        console.log(
          `  \x1b[33m○\x1b[0m ${check.name.padEnd(PAD_LABEL)} ${check.detail}`,
        );
        warnings++;
      } else {
        console.log(
          `  \x1b[31m✗\x1b[0m ${check.name.padEnd(PAD_LABEL)} ${check.detail}`,
        );
        failures++;
      }
      if (check.fix) {
        console.log(`${''.padEnd(4 + PAD_LABEL)}\x1b[90m↳ ${check.fix}\x1b[0m`);
      }
    }
  }

  console.log('');
  if (failures === 0 && warnings === 0) {
    console.log('\x1b[32mAll checks passed!\x1b[0m');
  } else if (failures === 0) {
    console.log(
      `\x1b[32mAll critical checks passed.\x1b[0m ${warnings} warning${warnings === 1 ? '' : 's'}.`,
    );
  } else {
    console.log(
      `\x1b[31m${failures} check${failures === 1 ? '' : 's'} failed.\x1b[0m Fix the issues above before running Dokkimi.`,
    );
  }
  console.log('');

  // Build per-check telemetry map
  const checkResults: Record<string, boolean | string> = {};
  for (const check of checks) {
    const key = check.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
    if (check.name === 'K8s Context') {
      checkResults[key] = check.detail;
    } else {
      checkResults[key] = check.pass;
    }
  }

  trackEvent('cli_doctor_result', {
    passed: failures === 0,
    failure_count: failures,
    warning_count: warnings,
    checks: checkResults,
  });

  if (failures > 0) {
    process.exit(1);
  }
}
