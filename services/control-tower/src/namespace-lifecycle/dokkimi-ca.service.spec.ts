import { Test, TestingModule } from '@nestjs/testing';
import { DokkimiCaService } from './dokkimi-ca.service';
import { KubernetesClientService } from './kubernetes/kubernetes-client.service';

describe('DokkimiCaService', () => {
  let service: DokkimiCaService;

  const mockCore = {
    readNamespacedSecret: jest.fn(),
    createNamespacedSecret: jest.fn(),
  };

  const mockK8sClient = {
    core: mockCore,
    createNamespace: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DokkimiCaService,
        { provide: KubernetesClientService, useValue: mockK8sClient },
      ],
    }).compile();

    service = module.get(DokkimiCaService);
  });

  describe('ensureCA', () => {
    it('should not generate a new CA when the secret already exists', async () => {
      mockCore.readNamespacedSecret.mockResolvedValue({
        data: { 'tls.crt': 'existing', 'tls.key': 'existing' },
      });

      await service.ensureCA();

      expect(mockCore.readNamespacedSecret).toHaveBeenCalledWith({
        name: 'dokkimi-ca',
        namespace: 'dokkimi-system',
      });
      expect(mockCore.createNamespacedSecret).not.toHaveBeenCalled();
    });

    it('should generate and store a new CA when the secret is not found (404)', async () => {
      mockCore.readNamespacedSecret.mockRejectedValue({ code: 404 });
      mockK8sClient.createNamespace.mockResolvedValue(undefined);
      mockCore.createNamespacedSecret.mockResolvedValue(undefined);

      await service.ensureCA();

      expect(mockK8sClient.createNamespace).toHaveBeenCalledWith(
        'dokkimi-system',
      );
      expect(mockCore.createNamespacedSecret).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: 'dokkimi-system',
          body: expect.objectContaining({
            type: 'kubernetes.io/tls',
            metadata: expect.objectContaining({
              name: 'dokkimi-ca',
              labels: expect.objectContaining({
                'app.kubernetes.io/name': 'dokkimi',
                'app.kubernetes.io/component': 'ca',
              }),
            }),
          }),
        }),
      );

      const body = mockCore.createNamespacedSecret.mock.calls[0][0].body;
      expect(body.data['tls.crt']).toBeDefined();
      expect(body.data['tls.key']).toBeDefined();
      expect(body.data['ca.crt']).toBe(body.data['tls.crt']);
    });

    it('should re-throw non-404 errors', async () => {
      mockCore.readNamespacedSecret.mockRejectedValue({ code: 500 });

      await expect(service.ensureCA()).rejects.toEqual({ code: 500 });
    });
  });

  describe('copyCAToNamespace', () => {
    it('should create two secrets in the target namespace', async () => {
      const caCrt = Buffer.from('cert-data').toString('base64');
      mockCore.readNamespacedSecret.mockResolvedValue({
        data: {
          'ca.crt': caCrt,
          'tls.crt': caCrt,
          'tls.key': 'key-data',
        },
      });
      mockCore.createNamespacedSecret.mockResolvedValue(undefined);

      await service.copyCAToNamespace('test-ns');

      expect(mockCore.createNamespacedSecret).toHaveBeenCalledTimes(2);

      const calls = mockCore.createNamespacedSecret.mock.calls;
      const certCall = calls.find(
        (c: any) => c[0].body.metadata.name === 'dokkimi-ca-cert',
      );
      const fullCall = calls.find(
        (c: any) => c[0].body.metadata.name === 'dokkimi-ca',
      );

      expect(certCall).toBeDefined();
      expect(certCall![0].body.type).toBe('Opaque');
      expect(certCall![0].body.data).toEqual({ 'ca.crt': caCrt });

      expect(fullCall).toBeDefined();
      expect(fullCall![0].body.type).toBe('kubernetes.io/tls');
    });

    it('should return silently when the CA secret is not found (404)', async () => {
      mockCore.readNamespacedSecret.mockRejectedValue({ code: 404 });

      await service.copyCAToNamespace('test-ns');

      expect(mockCore.createNamespacedSecret).not.toHaveBeenCalled();
    });

    it('should return without creating secrets when ca.crt is missing', async () => {
      mockCore.readNamespacedSecret.mockResolvedValue({
        data: { 'tls.key': 'key-only' },
      });

      await service.copyCAToNamespace('test-ns');

      expect(mockCore.createNamespacedSecret).not.toHaveBeenCalled();
    });

    it('should suppress 409 conflict when secret already exists', async () => {
      mockCore.readNamespacedSecret.mockResolvedValue({
        data: { 'ca.crt': 'cert', 'tls.crt': 'cert', 'tls.key': 'key' },
      });
      mockCore.createNamespacedSecret.mockRejectedValue({ code: 409 });

      await expect(
        service.copyCAToNamespace('test-ns'),
      ).resolves.toBeUndefined();
    });

    it('should re-throw non-404/non-409 errors', async () => {
      mockCore.readNamespacedSecret.mockRejectedValue({ code: 503 });

      await expect(service.copyCAToNamespace('test-ns')).rejects.toEqual({
        code: 503,
      });
    });
  });

  describe('onApplicationBootstrap', () => {
    it('should catch and not throw errors from ensureCA', async () => {
      mockCore.readNamespacedSecret.mockRejectedValue(
        new Error('no cluster access'),
      );

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    });
  });
});
