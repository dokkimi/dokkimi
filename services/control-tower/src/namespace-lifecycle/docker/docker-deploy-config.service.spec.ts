import { DockerDeployConfigService } from './docker-deploy-config.service';

jest.mock('@dokkimi/config', () => ({
  getConfig: () => ({
    services: {
      interceptor: { port: 8080 },
      controlTower: {
        port: 19001,
        host: 'host.docker.internal',
        protocol: 'http',
      },
      testAgent: { port: 8080 },
      chromium: { port: 9222 },
    },
    network: { dns: { nameserver: '127.0.0.1' } },
    database: {
      defaultName: 'dokkimi',
      defaultUser: 'dokkimi',
      defaultPassword: 'dokkimi',
    },
    browser: {},
  }),
}));

describe('DockerDeployConfigService', () => {
  let service: DockerDeployConfigService;

  beforeEach(() => {
    service = new DockerDeployConfigService({} as any);
  });

  describe('buildDnsmasqConfig', () => {
    it('should route database names to Docker DNS and catch-all to interceptor IP', () => {
      const config = service.buildDnsmasqConfig(
        '127.0.0.11',
        ['postgres-db', 'redis-cache'],
        '172.18.0.2',
      );

      expect(config).toContain('listen-address=127.0.0.1');
      expect(config).toContain('server=/postgres-db/127.0.0.11');
      expect(config).toContain('server=/redis-cache/127.0.0.11');
      expect(config).toContain('server=/host.docker.internal/127.0.0.11');
      expect(config).toContain('address=/#/172.18.0.2');
    });

    it('should work with no databases', () => {
      const config = service.buildDnsmasqConfig('127.0.0.11', [], '172.18.0.5');

      expect(config).not.toMatch(/server=\/(?!host\.docker\.internal)/);
      expect(config).toContain('server=/host.docker.internal/127.0.0.11');
      expect(config).toContain('address=/#/172.18.0.5');
    });

    it('should include standard dnsmasq options', () => {
      const config = service.buildDnsmasqConfig('127.0.0.11', [], '172.18.0.2');

      expect(config).toContain('cache-size=1000');
      expect(config).toContain('no-hosts');
      expect(config).toContain('no-resolv');
      expect(config).toContain('log-queries');
      expect(config).toContain('log-facility=-');
    });
  });
});
