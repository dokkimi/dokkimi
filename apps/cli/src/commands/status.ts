import {
  fetchJson,
  formatUptime,
  formatAge,
  PAD_NAME,
  PAD_STATUS,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  Instance,
} from '../lib/cli-utils';
import { loadConfig, buildServiceUrl } from '@dokkimi/config';
import { getServiceStatus } from '@dokkimi/service-manager';

export async function status(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: dokkimi status');
    console.log('');
    console.log('Show the status of Dokkimi and any running instances.');
    process.exit(0);
  }

  const config = loadConfig();
  const serviceStatus = await getServiceStatus(config);

  console.log('');
  if (serviceStatus.healthy) {
    console.log('\x1b[32m✓\x1b[0m Dokkimi is running');
    if (serviceStatus.startedAt) {
      const uptimeMs = Date.now() - new Date(serviceStatus.startedAt).getTime();
      const uptimeSeconds = Math.floor(uptimeMs / 1000);
      console.log(`  \x1b[90mUptime: ${formatUptime(uptimeSeconds)}\x1b[0m`);
    }
  } else {
    console.log('\x1b[31m✗\x1b[0m Dokkimi is not running');
    console.log('');
    console.log(
      '  Run \x1b[1mdokkimi run\x1b[0m to start, or \x1b[1mdokkimi doctor\x1b[0m to diagnose issues.',
    );
    console.log('');
    process.exit(0);
  }

  // Check K8s connectivity via CT health endpoint
  const ctUrl = buildServiceUrl(config.services.controlTower);
  const health = await fetchJson<{
    status: string;
    uptime: number;
    checks: {
      database: { status: string };
      kubernetes: { status: string };
      prisma: { status: string };
    };
  }>(`${ctUrl}/health`);

  if (health) {
    const k8sOk = health.checks.kubernetes.status === 'healthy';
    const dbOk = health.checks.database.status === 'healthy';
    if (k8sOk) {
      console.log('\x1b[32m✓\x1b[0m Kubernetes connected');
    } else {
      console.log('\x1b[31m✗\x1b[0m Kubernetes not connected');
      console.log(
        '  \x1b[90mEnsure Docker Desktop has Kubernetes enabled.\x1b[0m',
      );
    }
    if (!dbOk) {
      console.log('\x1b[31m✗\x1b[0m Database not available');
    }
  }

  // Get running instances
  const instances = await fetchJson<Instance[]>(
    `${ctUrl}/namespaces/instances`,
  );

  console.log('');
  if (!instances || instances.length === 0) {
    console.log('No active instances.');
  } else {
    const active = instances.filter((i) => ACTIVE_STATUSES.includes(i.status));
    const stopped = instances.filter((i) =>
      TERMINAL_STATUSES.includes(i.status),
    );

    if (active.length > 0) {
      console.log('Active instances:');
      for (const inst of active) {
        const statusColor = inst.status === 'RUNNING' ? '\x1b[32m' : '\x1b[33m';
        console.log(
          `  ${statusColor}${inst.status.padEnd(PAD_STATUS)}\x1b[0m ${(inst.definition?.name || inst.id).padEnd(PAD_NAME)} ${formatAge(inst.createdAt)}`,
        );
      }
    } else {
      console.log('No active instances.');
    }

    if (stopped.length > 0) {
      console.log(
        `  \x1b[90m+ ${stopped.length} stopped instance${stopped.length === 1 ? '' : 's'}\x1b[0m`,
      );
    }
  }

  console.log('');
}
