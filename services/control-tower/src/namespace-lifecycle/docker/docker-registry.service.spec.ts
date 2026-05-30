import { DockerRegistryService } from './docker-registry.service';

jest.mock('dockerode', () => {
  return jest.fn(() => ({}));
});

describe('DockerRegistryService', () => {
  let service: DockerRegistryService;

  beforeEach(() => {
    service = new DockerRegistryService();
  });

  describe('storeCredentials', () => {
    it('should store credentials for a run', () => {
      service.storeCredentials('run-1', [
        { registryUrl: 'ghcr.io', username: 'user', password: 'pass' },
      ]);

      const auth = service.getAuthConfig('run-1', 'ghcr.io/org/image:latest');
      expect(auth).toBeDefined();
      expect(auth!.username).toBe('user');
      expect(auth!.password).toBe('pass');
    });

    it('should not store empty credentials', () => {
      service.storeCredentials('run-1', []);
      expect(service.getAuthConfig('run-1', 'anything')).toBeUndefined();
    });
  });

  describe('getAuthConfig', () => {
    it('should match registry from image name', () => {
      service.storeCredentials('run-1', [
        { registryUrl: 'ghcr.io', username: 'u1', password: 'p1' },
        { registryUrl: 'registry.example.com', username: 'u2', password: 'p2' },
      ]);

      const auth1 = service.getAuthConfig('run-1', 'ghcr.io/org/image:tag');
      expect(auth1!.username).toBe('u1');

      const auth2 = service.getAuthConfig(
        'run-1',
        'registry.example.com/image:tag',
      );
      expect(auth2!.username).toBe('u2');
    });

    it('should return undefined for unknown registry', () => {
      service.storeCredentials('run-1', [
        { registryUrl: 'ghcr.io', username: 'u', password: 'p' },
      ]);

      const auth = service.getAuthConfig(
        'run-1',
        'registry.other.com/image:tag',
      );
      expect(auth).toBeUndefined();
    });

    it('should return undefined for unknown run', () => {
      expect(
        service.getAuthConfig('unknown-run', 'ghcr.io/image:tag'),
      ).toBeUndefined();
    });

    it('should default to Docker Hub for images without explicit registry', () => {
      service.storeCredentials('run-1', [
        {
          registryUrl: 'https://index.docker.io/v1/',
          username: 'u',
          password: 'p',
        },
      ]);

      const auth = service.getAuthConfig('run-1', 'nginx:latest');
      expect(auth).toBeDefined();
      expect(auth!.username).toBe('u');
    });
  });

  describe('clearCredentials', () => {
    it('should remove stored credentials for a run', () => {
      service.storeCredentials('run-1', [
        { registryUrl: 'ghcr.io', username: 'u', password: 'p' },
      ]);

      service.clearCredentials('run-1');

      expect(
        service.getAuthConfig('run-1', 'ghcr.io/image:tag'),
      ).toBeUndefined();
    });

    it('should not throw for unknown run', () => {
      expect(() => service.clearCredentials('unknown')).not.toThrow();
    });
  });
});
