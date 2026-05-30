import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DockerCaService } from './docker-ca.service';

describe('DockerCaService', () => {
  let service: DockerCaService;
  const testInstanceId = `test-ca-${Date.now()}`;

  beforeEach(() => {
    service = new DockerCaService();
  });

  afterEach(() => {
    const configDir = path.join(os.tmpdir(), `dokkimi-${testInstanceId}`);
    try {
      fs.rmSync(configDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('getCaPaths', () => {
    it('should return paths under ~/.dokkimi/ca/', () => {
      const paths = service.getCaPaths();
      expect(paths.certPath).toBe(
        path.join(os.homedir(), '.dokkimi', 'ca', 'ca.crt'),
      );
      expect(paths.keyPath).toBe(
        path.join(os.homedir(), '.dokkimi', 'ca', 'ca.key'),
      );
    });
  });

  describe('onApplicationBootstrap', () => {
    it('should create CA files if they do not exist', async () => {
      // The CA may already exist from a prior run, so just verify bootstrap doesn't throw
      await expect(service.onApplicationBootstrap()).resolves.not.toThrow();

      const paths = service.getCaPaths();
      expect(fs.existsSync(paths.certPath)).toBe(true);
      expect(fs.existsSync(paths.keyPath)).toBe(true);
    });

    it('should not overwrite existing CA', async () => {
      await service.onApplicationBootstrap();

      const paths = service.getCaPaths();
      const certBefore = fs.readFileSync(paths.certPath, 'utf-8');

      // Bootstrap again
      await service.onApplicationBootstrap();
      const certAfter = fs.readFileSync(paths.certPath, 'utf-8');

      expect(certAfter).toBe(certBefore);
    });
  });

  describe('prepareCaBundleForInstance', () => {
    it('should create a CA bundle file in the instance config dir', async () => {
      await service.onApplicationBootstrap();

      const bundlePaths = service.prepareCaBundleForInstance(testInstanceId);

      expect(fs.existsSync(bundlePaths.caBundlePath)).toBe(true);

      const bundleContent = fs.readFileSync(bundlePaths.caBundlePath, 'utf-8');
      // Bundle should contain the Dokkimi CA cert
      expect(bundleContent).toContain('BEGIN CERTIFICATE');
    });

    it('should return paths for cert, key, and bundle', async () => {
      await service.onApplicationBootstrap();

      const bundlePaths = service.prepareCaBundleForInstance(testInstanceId);

      expect(bundlePaths.caCertPath).toBe(service.getCaPaths().certPath);
      expect(bundlePaths.caKeyPath).toBe(service.getCaPaths().keyPath);
      expect(bundlePaths.caBundlePath).toContain(testInstanceId);
    });
  });

  describe('getInterceptorCaBinds', () => {
    it('should return bind mount strings for cert and key', () => {
      const binds = service.getInterceptorCaBinds();

      expect(binds).toHaveLength(2);
      expect(binds[0]).toContain('ca.crt:/etc/dokkimi/ca/tls.crt:ro');
      expect(binds[1]).toContain('ca.key:/etc/dokkimi/ca/tls.key:ro');
    });
  });

  describe('getServiceCaBinds', () => {
    it('should return bind mount strings for cert and bundle', async () => {
      await service.onApplicationBootstrap();
      const bundlePaths = service.prepareCaBundleForInstance(testInstanceId);

      const binds = service.getServiceCaBinds(bundlePaths);

      expect(binds).toHaveLength(2);
      expect(binds[0]).toContain('dokkimi-ca.crt:ro');
      expect(binds[1]).toContain('ca-bundle.crt:ro');
    });
  });

  describe('getServiceCaEnvVars', () => {
    it('should return CA-related env vars for service containers', () => {
      const envVars = service.getServiceCaEnvVars();

      expect(envVars.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/certs/dokkimi-ca.crt');
      expect(envVars.SSL_CERT_FILE).toBe('/ca-bundle/ca-bundle.crt');
      expect(envVars.REQUESTS_CA_BUNDLE).toBe('/ca-bundle/ca-bundle.crt');
      expect(envVars.CURL_CA_BUNDLE).toBe('/ca-bundle/ca-bundle.crt');
    });
  });

  describe('getInterceptorCaEnvVars', () => {
    it('should return CA paths for interceptor containers', () => {
      const envVars = service.getInterceptorCaEnvVars();

      expect(envVars.DOKKIMI_CA_CERT_PATH).toBe('/etc/dokkimi/ca/tls.crt');
      expect(envVars.DOKKIMI_CA_KEY_PATH).toBe('/etc/dokkimi/ca/tls.key');
    });
  });
});
