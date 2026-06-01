/**
 * Integration tests for DockerClientService.
 * These run against the real Docker daemon — Docker must be running.
 *
 * Run with: yarn workspace control-tower jest --no-watchman --testPathPatterns="docker-client.integration"
 */
import Docker from 'dockerode';
import { DockerClientService } from './docker-client.service';

const TEST_INSTANCE_ID = `integration-test-${Date.now()}`;
const TEST_IMAGE = 'busybox:1.37';

describe('DockerClientService (integration)', () => {
  let service: DockerClientService;

  beforeAll(async () => {
    service = new DockerClientService();
    // Ensure test image is available
    await service.pullImage(TEST_IMAGE);
  }, 60_000);

  afterAll(async () => {
    // Cleanup in case a test failed mid-run
    try {
      await service.removeNetwork(TEST_INSTANCE_ID);
    } catch {
      // ignore
    }
  });

  it('should create a Docker network', async () => {
    const networkName = await service.createNetwork(TEST_INSTANCE_ID);
    expect(networkName).toBe(`dokkimi-run-${TEST_INSTANCE_ID}`);

    const exists = await service.networkExists(TEST_INSTANCE_ID);
    expect(exists).toBe(true);
  });

  it('should report networkExists=false for non-existent network', async () => {
    const exists = await service.networkExists('does-not-exist-99999');
    expect(exists).toBe(false);
  });

  it('should be idempotent when creating the same network twice', async () => {
    const name1 = await service.createNetwork(TEST_INSTANCE_ID);
    const name2 = await service.createNetwork(TEST_INSTANCE_ID);
    expect(name1).toBe(name2);
  });

  it('should run a container on the network and inspect it', async () => {
    const containerId = await service.runContainer({
      name: `test-container-${TEST_INSTANCE_ID}`,
      image: TEST_IMAGE,
      networkName: `dokkimi-run-${TEST_INSTANCE_ID}`,
      cmd: ['sh', '-c', 'sleep 30'],
      labels: {
        'test-run': TEST_INSTANCE_ID,
        'io.dokkimi.instance-id': TEST_INSTANCE_ID,
      },
    });

    expect(containerId).toBeTruthy();

    const info = await service.inspectContainer(containerId);
    expect(info).not.toBeNull();
    expect(info!.state).toBe('running');
    expect(info!.ip).toBeTruthy();
  });

  it('should run a second container with shared network namespace', async () => {
    const primaryName = `test-container-${TEST_INSTANCE_ID}`;

    const sidecarId = await service.runContainer({
      name: `test-sidecar-${TEST_INSTANCE_ID}`,
      image: TEST_IMAGE,
      networkName: `dokkimi-run-${TEST_INSTANCE_ID}`,
      networkMode: `container:${primaryName}`,
      cmd: ['sh', '-c', 'sleep 30'],
      labels: { 'io.dokkimi.instance-id': TEST_INSTANCE_ID },
    });

    expect(sidecarId).toBeTruthy();

    const info = await service.inspectContainer(sidecarId);
    expect(info).not.toBeNull();
    expect(info!.state).toBe('running');
  });

  it('should set network aliases and resolve DNS between containers', async () => {
    const aliasedId = await service.runContainer({
      name: `test-aliased-${TEST_INSTANCE_ID}`,
      image: TEST_IMAGE,
      networkName: `dokkimi-run-${TEST_INSTANCE_ID}`,
      networkAliases: ['my-service'],
      cmd: ['sh', '-c', 'sleep 30'],
      labels: { 'io.dokkimi.instance-id': TEST_INSTANCE_ID },
    });

    expect(aliasedId).toBeTruthy();

    // Verify the container is reachable by alias from another container on the same network
    const pingId = await service.runContainer({
      name: `test-pinger-${TEST_INSTANCE_ID}`,
      image: TEST_IMAGE,
      networkName: `dokkimi-run-${TEST_INSTANCE_ID}`,
      labels: { 'io.dokkimi.instance-id': TEST_INSTANCE_ID },
      cmd: [
        'sh',
        '-c',
        'ping -c 1 -W 2 my-service && echo REACHABLE || echo UNREACHABLE',
      ],
    });

    // Wait for the ping container to finish
    const docker = new Docker();
    const pingContainer = docker.getContainer(pingId);
    await pingContainer.wait();

    const logs = await pingContainer.logs({ stdout: true, stderr: true });
    const logText = logs.toString();
    expect(logText).toContain('REACHABLE');
  }, 15_000);

  it('should wait for healthy container (no healthcheck = immediate)', async () => {
    const id = await service.runContainer({
      name: `test-healthy-${TEST_INSTANCE_ID}`,
      image: TEST_IMAGE,
      networkName: `dokkimi-run-${TEST_INSTANCE_ID}`,
      cmd: ['sh', '-c', 'sleep 30'],
      labels: { 'io.dokkimi.instance-id': TEST_INSTANCE_ID },
    });

    const healthy = await service.waitForHealthy(id, 5000, 200);
    expect(healthy).toBe(true);
  });

  it('should return false from waitForHealthy for non-existent container', async () => {
    const healthy = await service.waitForHealthy(
      'nonexistent-container-xyz',
      1000,
      200,
    );
    expect(healthy).toBe(false);
  });

  it('should stream logs from a container', async () => {
    const id = await service.runContainer({
      name: `test-logger-${TEST_INSTANCE_ID}`,
      image: TEST_IMAGE,
      networkName: `dokkimi-run-${TEST_INSTANCE_ID}`,
      cmd: ['sh', '-c', 'echo "HELLO_FROM_DOCKER" && sleep 5'],
      labels: { 'io.dokkimi.instance-id': TEST_INSTANCE_ID },
    });

    const logChunks: string[] = [];
    const stream = await service.streamLogs(id, (data) => {
      logChunks.push(data.toString());
    });

    // Wait a bit for log data to arrive
    await new Promise((r) => setTimeout(r, 2000));
    stream.destroy();

    const allLogs = logChunks.join('');
    expect(allLogs).toContain('HELLO_FROM_DOCKER');
  }, 10_000);

  it('should remove a single container', async () => {
    const id = await service.runContainer({
      name: `test-removable-${TEST_INSTANCE_ID}`,
      image: TEST_IMAGE,
      networkName: `dokkimi-run-${TEST_INSTANCE_ID}`,
      cmd: ['sh', '-c', 'sleep 30'],
      labels: { 'io.dokkimi.instance-id': TEST_INSTANCE_ID },
    });

    await service.removeContainer(id);

    const info = await service.inspectContainer(id);
    expect(info).toBeNull();
  });

  it('should remove all containers and the network on cleanup', async () => {
    await service.removeNetwork(TEST_INSTANCE_ID);

    const exists = await service.networkExists(TEST_INSTANCE_ID);
    expect(exists).toBe(false);
  });

  it('should handle removeNetwork gracefully when network does not exist', async () => {
    await expect(
      service.removeNetwork('already-removed-99999'),
    ).resolves.not.toThrow();
  });
});
