import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import Docker from 'dockerode';

export interface RunContainerOptions {
  name: string;
  image: string;
  networkName: string;
  networkAliases?: string[];
  env?: Record<string, string>;
  binds?: string[];
  dns?: string[];
  /** Join another container's network namespace instead of the run network. */
  networkMode?: string;
  healthcheck?: {
    test: string[];
    intervalMs?: number;
    timeoutMs?: number;
    retries?: number;
    startPeriodMs?: number;
  };
  labels?: Record<string, string>;
  cmd?: string[];
  entrypoint?: string[];
  exposedPorts?: number[];
}

export interface ContainerInfo {
  id: string;
  name: string;
  ip: string;
  state: string;
  health?: string;
}

const DOKKIMI_NETWORK_PREFIX = 'dokkimi-run-';
const DOKKIMI_LABEL = 'io.dokkimi.managed';

@Injectable()
export class DockerClientService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DockerClientService.name);
  private readonly docker: Docker;

  constructor() {
    this.docker = new Docker();
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.cleanupOrphanedResources();
    } catch (error) {
      this.logger.warn(
        'Failed to clean up orphaned Docker resources on startup:',
        error instanceof Error ? error.message : error,
      );
    }
  }

  // ============================================
  // NETWORK OPERATIONS (replaces K8s namespaces)
  // ============================================

  async createNetwork(instanceId: string): Promise<string> {
    const networkName = `${DOKKIMI_NETWORK_PREFIX}${instanceId}`;

    const existing = await this.findNetwork(networkName);
    if (existing) {
      this.logger.log(`Docker network ${networkName} already exists`);
      return networkName;
    }

    await this.docker.createNetwork({
      Name: networkName,
      Driver: 'bridge',
      Labels: {
        [DOKKIMI_LABEL]: 'true',
        'io.dokkimi.instance-id': instanceId,
      },
    });

    this.logger.log(`Created Docker network: ${networkName}`);
    return networkName;
  }

  async removeNetwork(instanceId: string): Promise<void> {
    const networkName = `${DOKKIMI_NETWORK_PREFIX}${instanceId}`;

    await this.removeAllContainers(networkName);

    const network = await this.findNetwork(networkName);
    if (network) {
      await network.remove();
      this.logger.log(`Removed Docker network: ${networkName}`);
    }
  }

  async networkExists(instanceId: string): Promise<boolean> {
    const networkName = `${DOKKIMI_NETWORK_PREFIX}${instanceId}`;
    const network = await this.findNetwork(networkName);
    return network !== null;
  }

  // ============================================
  // CONTAINER OPERATIONS (replaces K8s deployments)
  // ============================================

  async runContainer(opts: RunContainerOptions): Promise<string> {
    const env = opts.env
      ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`)
      : [];

    const isSharedNetworkMode =
      opts.networkMode && opts.networkMode.startsWith('container:');

    const extraHosts =
      process.platform === 'linux' ? ['host.docker.internal:host-gateway'] : [];

    const exposedPorts: Record<string, object> = {};
    if (opts.exposedPorts) {
      for (const port of opts.exposedPorts) {
        exposedPorts[`${port}/tcp`] = {};
      }
    }

    const createOptions: Docker.ContainerCreateOptions = {
      name: opts.name,
      Image: opts.image,
      Env: env,
      Labels: {
        [DOKKIMI_LABEL]: 'true',
        ...opts.labels,
      },
      ExposedPorts:
        Object.keys(exposedPorts).length > 0 ? exposedPorts : undefined,
      ...(opts.cmd && { Cmd: opts.cmd }),
      ...(opts.entrypoint && { Entrypoint: opts.entrypoint }),
      ...(opts.healthcheck && {
        Healthcheck: {
          Test: opts.healthcheck.test,
          Interval: (opts.healthcheck.intervalMs ?? 5000) * 1_000_000,
          Timeout: (opts.healthcheck.timeoutMs ?? 3000) * 1_000_000,
          Retries: opts.healthcheck.retries ?? 3,
          StartPeriod: (opts.healthcheck.startPeriodMs ?? 2000) * 1_000_000,
        },
      }),
      HostConfig: {
        Binds: opts.binds,
        Dns: opts.dns,
        ExtraHosts: extraHosts.length > 0 ? extraHosts : undefined,
        ...(isSharedNetworkMode
          ? { NetworkMode: opts.networkMode }
          : { NetworkMode: opts.networkName }),
      },
    };

    const container = await this.docker.createContainer(createOptions);

    // When not using shared network mode, connect to the run network with aliases
    if (!isSharedNetworkMode && opts.networkAliases?.length) {
      const network = await this.findNetwork(opts.networkName);
      if (network) {
        await network.disconnect({ Container: container.id });
        await network.connect({
          Container: container.id,
          EndpointConfig: { Aliases: opts.networkAliases },
        });
      }
    }

    await container.start();
    this.logger.log(`Started container: ${opts.name}`);
    return container.id;
  }

  async removeContainer(nameOrId: string): Promise<void> {
    try {
      const container = this.docker.getContainer(nameOrId);
      await container.remove({ force: true });
      this.logger.log(`Removed container: ${nameOrId}`);
    } catch (error: unknown) {
      if (this.is404(error)) {
        return;
      }
      throw error;
    }
  }

  async inspectContainer(nameOrId: string): Promise<ContainerInfo | null> {
    try {
      const container = this.docker.getContainer(nameOrId);
      const info = await container.inspect();

      const networks = info.NetworkSettings?.Networks || {};
      const firstNetwork = Object.values(networks)[0];
      const ip = firstNetwork?.IPAddress || '';

      return {
        id: info.Id,
        name: info.Name.replace(/^\//, ''),
        ip,
        state: info.State?.Status || 'unknown',
        health: info.State?.Health?.Status,
      };
    } catch (error: unknown) {
      if (this.is404(error)) {
        return null;
      }
      throw error;
    }
  }

  async waitForHealthy(
    nameOrId: string,
    timeoutMs: number = 60000,
    pollIntervalMs: number = 1000,
  ): Promise<boolean> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const info = await this.inspectContainer(nameOrId);
      if (!info) {
        return false;
      }

      if (info.state !== 'running') {
        return false;
      }

      // No healthcheck configured — treat as healthy once running
      if (!info.health) {
        return true;
      }

      if (info.health === 'healthy') {
        return true;
      }

      await this.sleep(pollIntervalMs);
    }

    return false;
  }

  async streamLogs(
    nameOrId: string,
    onData: (data: Buffer) => void,
  ): Promise<{ destroy: () => void }> {
    const container = this.docker.getContainer(nameOrId);
    const stream = (await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
    })) as unknown as NodeJS.ReadableStream;

    stream.on('data', onData);

    return {
      destroy: () => {
        stream.removeAllListeners();
        if ('destroy' in stream && typeof stream.destroy === 'function') {
          (stream as NodeJS.ReadableStream & { destroy: () => void }).destroy();
        }
      },
    };
  }

  async pullImage(image: string): Promise<void> {
    try {
      // Check if image exists locally first
      await this.docker.getImage(image).inspect();
      return;
    } catch {
      // Image not found locally, pull it
    }

    this.logger.log(`Pulling image: ${image}`);
    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err: Error | null) =>
        err ? reject(err) : resolve(),
      );
    });
    this.logger.log(`Pulled image: ${image}`);
  }

  // ============================================
  // CLEANUP
  // ============================================

  async removeAllContainers(networkName: string): Promise<void> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { network: [networkName] },
    });

    if (containers.length === 0) {
      return;
    }

    await Promise.all(
      containers.map(async (c) => {
        try {
          await this.docker.getContainer(c.Id).remove({ force: true });
        } catch (error: unknown) {
          if (!this.is404(error)) {
            this.logger.warn(`Failed to remove container ${c.Id}: ${error}`);
          }
        }
      }),
    );

    this.logger.log(
      `Removed ${containers.length} containers from network ${networkName}`,
    );
  }

  async cleanupOrphanedResources(): Promise<void> {
    const networks = await this.docker.listNetworks({
      filters: {
        label: [DOKKIMI_LABEL],
      },
    });

    if (networks.length === 0) {
      return;
    }

    this.logger.log(
      `Found ${networks.length} orphaned Dokkimi network(s), cleaning up...`,
    );

    for (const net of networks) {
      try {
        await this.removeAllContainers(net.Name);
        await this.docker.getNetwork(net.Id).remove();
        this.logger.log(`Cleaned up orphaned network: ${net.Name}`);
      } catch (error) {
        this.logger.warn(`Failed to clean up network ${net.Name}: ${error}`);
      }
    }
  }

  // ============================================
  // DOCKER DNS
  // ============================================

  getDockerDnsIP(): string {
    return '127.0.0.11';
  }

  // ============================================
  // PRIVATE
  // ============================================

  private async findNetwork(name: string): Promise<Docker.Network | null> {
    const networks = await this.docker.listNetworks({
      filters: { name: [name] },
    });
    // Docker name filter is a substring match, so verify exact match
    const match = networks.find((n) => n.Name === name);
    return match ? this.docker.getNetwork(match.Id) : null;
  }

  private is404(error: unknown): boolean {
    return (
      error instanceof Error &&
      'statusCode' in error &&
      (error as { statusCode: number }).statusCode === 404
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
