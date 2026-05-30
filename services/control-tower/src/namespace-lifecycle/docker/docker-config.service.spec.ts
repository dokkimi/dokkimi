import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DockerConfigService } from './docker-config.service';

const mockConfigMapBuilder = {
  buildInterceptorConfigMap: jest.fn().mockReturnValue({
    data: {
      urlMap: '{}',
      httpMocks: '[]',
      'fluent-bit.conf': '[SERVICE]',
      podNameToNamespaceItemId: '{}',
    },
  }),
};

describe('DockerConfigService', () => {
  let service: DockerConfigService;
  const testInstanceId = `test-config-${Date.now()}`;
  let configDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DockerConfigService(mockConfigMapBuilder as any);
    configDir = path.join(os.tmpdir(), `dokkimi-${testInstanceId}`);
  });

  afterEach(() => {
    try {
      fs.rmSync(configDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('createConfigDir', () => {
    it('should create config and dnsmasq directories', () => {
      const paths = service.createConfigDir(testInstanceId);

      expect(paths.configDir).toBe(configDir);
      expect(paths.dnsmasqDir).toBe(path.join(configDir, 'dnsmasq'));
      expect(fs.existsSync(paths.configDir)).toBe(true);
      expect(fs.existsSync(paths.dnsmasqDir)).toBe(true);
    });

    it('should be idempotent', () => {
      service.createConfigDir(testInstanceId);
      const paths = service.createConfigDir(testInstanceId);
      expect(fs.existsSync(paths.configDir)).toBe(true);
    });
  });

  describe('writeInterceptorConfig', () => {
    it('should write config JSON to the config dir', () => {
      const paths = service.createConfigDir(testInstanceId);

      service.writeInterceptorConfig(paths, [], [], testInstanceId);

      expect(fs.existsSync(paths.configJsonPath)).toBe(true);
      const content = JSON.parse(fs.readFileSync(paths.configJsonPath, 'utf-8'));
      expect(content).toHaveProperty('urlMap');
      expect(content).toHaveProperty('httpMocks');
    });

    it('should pass items and mocks to the configmap builder', () => {
      const paths = service.createConfigDir(testInstanceId);
      const items = [{ name: 'svc', k8sName: 'svc', type: 'SERVICE' }];
      const mocks = [{ method: 'GET', origin: '', target: '*', path: '*' }];

      service.writeInterceptorConfig(
        paths,
        items as any,
        mocks,
        testInstanceId,
      );

      expect(mockConfigMapBuilder.buildInterceptorConfigMap).toHaveBeenCalledWith(
        `dokkimi-run-${testInstanceId}`,
        items,
        mocks,
        testInstanceId,
        undefined,
        undefined,
      );
    });
  });

  describe('writeDnsmasqConfig', () => {
    it('should write dnsmasq config file and return the path', () => {
      const paths = service.createConfigDir(testInstanceId);
      const dnsmasqConf = 'address=/#/127.0.0.1\nno-resolv';

      const confPath = service.writeDnsmasqConfig(
        paths,
        'service-a',
        dnsmasqConf,
      );

      expect(confPath).toBe(
        path.join(paths.dnsmasqDir, 'service-a.conf'),
      );
      expect(fs.readFileSync(confPath, 'utf-8')).toBe(dnsmasqConf);
    });
  });

  describe('cleanupConfigDir', () => {
    it('should remove the config directory', () => {
      service.createConfigDir(testInstanceId);
      expect(fs.existsSync(configDir)).toBe(true);

      service.cleanupConfigDir(testInstanceId);
      expect(fs.existsSync(configDir)).toBe(false);
    });

    it('should not throw for non-existent directory', () => {
      expect(() => service.cleanupConfigDir('nonexistent')).not.toThrow();
    });
  });
});
