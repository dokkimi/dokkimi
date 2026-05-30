import { DockerClientService } from './docker-client.service';

const mockContainer = {
  id: 'container-123',
  start: jest.fn(),
  stop: jest.fn(),
  remove: jest.fn(),
  inspect: jest.fn(),
  logs: jest.fn(),
};

const mockNetwork = {
  id: 'network-456',
  remove: jest.fn(),
  connect: jest.fn(),
  disconnect: jest.fn(),
};

const mockDocker = {
  createNetwork: jest.fn(),
  listNetworks: jest.fn().mockResolvedValue([]),
  getNetwork: jest.fn().mockReturnValue(mockNetwork),
  createContainer: jest.fn().mockResolvedValue(mockContainer),
  listContainers: jest.fn().mockResolvedValue([]),
  getContainer: jest.fn().mockReturnValue(mockContainer),
  getImage: jest.fn().mockReturnValue({ inspect: jest.fn() }),
  pull: jest.fn(),
  modem: { followProgress: jest.fn() },
};

jest.mock('dockerode', () => {
  return jest.fn(() => mockDocker);
});

describe('DockerClientService', () => {
  let service: DockerClientService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDocker.listNetworks.mockResolvedValue([]);
    mockDocker.listContainers.mockResolvedValue([]);
    service = new DockerClientService();
  });

  describe('createNetwork', () => {
    it('should create a new Docker network with correct name and labels', async () => {
      const networkName = await service.createNetwork('test-instance-1');

      expect(networkName).toBe('dokkimi-run-test-instance-1');
      expect(mockDocker.createNetwork).toHaveBeenCalledWith({
        Name: 'dokkimi-run-test-instance-1',
        Driver: 'bridge',
        Labels: {
          'io.dokkimi.managed': 'true',
          'io.dokkimi.instance-id': 'test-instance-1',
        },
      });
    });

    it('should return existing network name if network already exists', async () => {
      mockDocker.listNetworks.mockResolvedValue([
        { Name: 'dokkimi-run-test-instance-1', Id: 'net-1' },
      ]);

      const networkName = await service.createNetwork('test-instance-1');

      expect(networkName).toBe('dokkimi-run-test-instance-1');
      expect(mockDocker.createNetwork).not.toHaveBeenCalled();
    });
  });

  describe('removeNetwork', () => {
    it('should remove all containers then remove the network', async () => {
      mockDocker.listContainers.mockResolvedValue([{ Id: 'c1' }, { Id: 'c2' }]);
      mockDocker.listNetworks.mockResolvedValue([
        { Name: 'dokkimi-run-inst-1', Id: 'net-1' },
      ]);

      await service.removeNetwork('inst-1');

      expect(mockDocker.listContainers).toHaveBeenCalledWith({
        all: true,
        filters: { network: ['dokkimi-run-inst-1'] },
      });
      expect(mockDocker.getContainer).toHaveBeenCalledWith('c1');
      expect(mockDocker.getContainer).toHaveBeenCalledWith('c2');
      expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
      expect(mockNetwork.remove).toHaveBeenCalled();
    });

    it('should handle non-existent network gracefully', async () => {
      mockDocker.listNetworks.mockResolvedValue([]);

      await expect(service.removeNetwork('nonexistent')).resolves.not.toThrow();
    });
  });

  describe('networkExists', () => {
    it('should return true when network exists', async () => {
      mockDocker.listNetworks.mockResolvedValue([
        { Name: 'dokkimi-run-inst-1', Id: 'net-1' },
      ]);

      expect(await service.networkExists('inst-1')).toBe(true);
    });

    it('should return false when network does not exist', async () => {
      expect(await service.networkExists('inst-1')).toBe(false);
    });

    it('should not match on partial name', async () => {
      mockDocker.listNetworks.mockResolvedValue([
        { Name: 'dokkimi-run-inst-1-extra', Id: 'net-1' },
      ]);

      expect(await service.networkExists('inst-1')).toBe(false);
    });
  });

  describe('runContainer', () => {
    it('should create and start a container on the specified network', async () => {
      const containerId = await service.runContainer({
        name: 'interceptor-test',
        image: 'ghcr.io/dokkimi/interceptor:latest',
        networkName: 'dokkimi-run-inst-1',
        env: { PORT: '80', NODE_ENV: 'test' },
      });

      expect(containerId).toBe('container-123');
      expect(mockDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'interceptor-test',
          Image: 'ghcr.io/dokkimi/interceptor:latest',
          Env: ['PORT=80', 'NODE_ENV=test'],
          HostConfig: expect.objectContaining({
            NetworkMode: 'dokkimi-run-inst-1',
          }),
        }),
      );
      expect(mockContainer.start).toHaveBeenCalled();
    });

    it('should set networkMode to container: for shared network namespace', async () => {
      await service.runContainer({
        name: 'dnsmasq-test',
        image: 'andyshinn/dnsmasq:2.83',
        networkName: 'dokkimi-run-inst-1',
        networkMode: 'container:interceptor-test',
      });

      expect(mockDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          HostConfig: expect.objectContaining({
            NetworkMode: 'container:interceptor-test',
          }),
        }),
      );
    });

    it('should pass bind mounts and DNS config', async () => {
      await service.runContainer({
        name: 'service-a',
        image: 'user-image:tag',
        networkName: 'dokkimi-run-inst-1',
        binds: ['/tmp/config.json:/etc/dokkimi/config.json:ro'],
        dns: ['127.0.0.1'],
      });

      expect(mockDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          HostConfig: expect.objectContaining({
            Binds: ['/tmp/config.json:/etc/dokkimi/config.json:ro'],
            Dns: ['127.0.0.1'],
          }),
        }),
      );
    });

    it('should set network aliases when provided', async () => {
      mockDocker.listNetworks.mockResolvedValue([
        { Name: 'dokkimi-run-inst-1', Id: 'net-1' },
      ]);

      await service.runContainer({
        name: 'service-a-interceptor',
        image: 'ghcr.io/dokkimi/interceptor:latest',
        networkName: 'dokkimi-run-inst-1',
        networkAliases: ['service-a'],
      });

      expect(mockNetwork.disconnect).toHaveBeenCalledWith({
        Container: 'container-123',
      });
      expect(mockNetwork.connect).toHaveBeenCalledWith({
        Container: 'container-123',
        EndpointConfig: { Aliases: ['service-a'] },
      });
    });

    it('should configure healthcheck when provided', async () => {
      await service.runContainer({
        name: 'service-a',
        image: 'user-image:tag',
        networkName: 'dokkimi-run-inst-1',
        healthcheck: {
          test: ['CMD', 'curl', '-f', 'http://localhost/health'],
          intervalMs: 5000,
          timeoutMs: 3000,
          retries: 3,
          startPeriodMs: 2000,
        },
      });

      expect(mockDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          Healthcheck: {
            Test: ['CMD', 'curl', '-f', 'http://localhost/health'],
            Interval: 5000 * 1_000_000,
            Timeout: 3000 * 1_000_000,
            Retries: 3,
            StartPeriod: 2000 * 1_000_000,
          },
        }),
      );
    });
  });

  describe('removeContainer', () => {
    it('should force-remove the container', async () => {
      await service.removeContainer('container-123');

      expect(mockDocker.getContainer).toHaveBeenCalledWith('container-123');
      expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
    });

    it('should silently handle 404 (already removed)', async () => {
      const error = new Error('not found') as Error & { statusCode: number };
      error.statusCode = 404;
      mockContainer.remove.mockRejectedValueOnce(error);

      await expect(
        service.removeContainer('gone-container'),
      ).resolves.not.toThrow();
    });
  });

  describe('inspectContainer', () => {
    it('should return container info with IP from network settings', async () => {
      mockContainer.inspect.mockResolvedValue({
        Id: 'c-123',
        Name: '/service-a',
        State: { Status: 'running', Health: { Status: 'healthy' } },
        NetworkSettings: {
          Networks: {
            'dokkimi-run-inst-1': { IPAddress: '172.18.0.5' },
          },
        },
      });

      const info = await service.inspectContainer('service-a');

      expect(info).toEqual({
        id: 'c-123',
        name: 'service-a',
        ip: '172.18.0.5',
        state: 'running',
        health: 'healthy',
      });
    });

    it('should return null for non-existent container', async () => {
      const error = new Error('not found') as Error & { statusCode: number };
      error.statusCode = 404;
      mockContainer.inspect.mockRejectedValueOnce(error);

      const info = await service.inspectContainer('nonexistent');
      expect(info).toBeNull();
    });
  });

  describe('waitForHealthy', () => {
    it('should return true immediately for running container without healthcheck', async () => {
      mockContainer.inspect.mockResolvedValue({
        Id: 'c-123',
        Name: '/svc',
        State: { Status: 'running' },
        NetworkSettings: { Networks: {} },
      });

      const result = await service.waitForHealthy('svc', 5000, 100);
      expect(result).toBe(true);
    });

    it('should return false for non-existent container', async () => {
      const error = new Error('not found') as Error & { statusCode: number };
      error.statusCode = 404;
      mockContainer.inspect.mockRejectedValue(error);

      const result = await service.waitForHealthy('gone', 1000, 100);
      expect(result).toBe(false);
    });

    it('should return false for stopped container', async () => {
      mockContainer.inspect.mockResolvedValue({
        Id: 'c-123',
        Name: '/svc',
        State: { Status: 'exited' },
        NetworkSettings: { Networks: {} },
      });

      const result = await service.waitForHealthy('svc', 1000, 100);
      expect(result).toBe(false);
    });
  });

  describe('cleanupOrphanedResources', () => {
    it('should remove all containers and networks with dokkimi label', async () => {
      mockDocker.listNetworks.mockResolvedValue([
        { Name: 'dokkimi-run-orphan-1', Id: 'net-1' },
        { Name: 'dokkimi-run-orphan-2', Id: 'net-2' },
      ]);

      // First call for orphan-1 containers, second for orphan-2
      mockDocker.listContainers
        .mockResolvedValueOnce([{ Id: 'c1' }])
        .mockResolvedValueOnce([]);

      await service.cleanupOrphanedResources();

      expect(mockDocker.listNetworks).toHaveBeenCalledWith({
        filters: { label: ['io.dokkimi.managed'] },
      });
      expect(mockDocker.getContainer).toHaveBeenCalledWith('c1');
      expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
      // Both networks should be removed
      expect(mockNetwork.remove).toHaveBeenCalledTimes(2);
    });

    it('should do nothing when no orphaned networks exist', async () => {
      await service.cleanupOrphanedResources();

      expect(mockDocker.listNetworks).toHaveBeenCalled();
      expect(mockNetwork.remove).not.toHaveBeenCalled();
    });
  });

  describe('getDockerDnsIP', () => {
    it('should return the Docker embedded DNS IP', () => {
      expect(service.getDockerDnsIP()).toBe('127.0.0.11');
    });
  });

  describe('pullImage', () => {
    it('should skip pull if image exists locally', async () => {
      await service.pullImage('ghcr.io/dokkimi/interceptor:latest');

      expect(mockDocker.pull).not.toHaveBeenCalled();
    });

    it('should pull image if not found locally', async () => {
      mockDocker
        .getImage()
        .inspect.mockRejectedValueOnce(new Error('not found'));

      const pullStream = { on: jest.fn() };
      mockDocker.pull.mockResolvedValue(pullStream);
      mockDocker.modem.followProgress.mockImplementation(
        (_stream: unknown, cb: (err: Error | null) => void) => cb(null),
      );

      await service.pullImage('new-image:latest');

      expect(mockDocker.pull).toHaveBeenCalledWith('new-image:latest', {});
    });
  });
});
