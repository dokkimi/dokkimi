import { Test, TestingModule } from '@nestjs/testing';
import { RegistryCredentialsService } from './registry-credentials.service';
import { KubernetesClientService } from './kubernetes/kubernetes-client.service';

jest.mock('./kubernetes/kubernetes-helpers', () => {
  const actual = jest.requireActual('./kubernetes/kubernetes-helpers');
  return {
    ...actual,
    sleep: jest.fn().mockResolvedValue(undefined),
  };
});

describe('RegistryCredentialsService', () => {
  let service: RegistryCredentialsService;

  const mockCore = {
    createNamespacedSecret: jest.fn(),
    readNamespacedSecret: jest.fn(),
    deleteNamespacedSecret: jest.fn(),
    listNamespacedSecret: jest.fn(),
    readNamespacedServiceAccount: jest.fn(),
    replaceNamespacedServiceAccount: jest.fn(),
  };

  const mockK8sClient = {
    core: mockCore,
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RegistryCredentialsService,
        { provide: KubernetesClientService, useValue: mockK8sClient },
      ],
    }).compile();

    service = module.get(RegistryCredentialsService);
  });

  describe('createRunSecret', () => {
    it('should return immediately for empty credentials', async () => {
      await service.createRunSecret('run-1', []);
      expect(mockCore.createNamespacedSecret).not.toHaveBeenCalled();
    });

    it('should create a dockerconfigjson secret with correct auth', async () => {
      mockCore.createNamespacedSecret.mockResolvedValue(undefined);

      await service.createRunSecret('run-1', [
        {
          registryUrl: 'ghcr.io',
          username: 'user',
          password: 'pass',
        },
      ]);

      const call = mockCore.createNamespacedSecret.mock.calls[0][0];
      expect(call.namespace).toBe('dokkimi-system');
      expect(call.body.type).toBe('kubernetes.io/dockerconfigjson');
      expect(call.body.metadata.name).toBe('run-run-1-registry-creds');
      expect(call.body.metadata.labels['dokkimi.io/run-id']).toBe('run-1');

      const configJson = Buffer.from(
        call.body.data['.dockerconfigjson'],
        'base64',
      ).toString();
      const config = JSON.parse(configJson);
      expect(config.auths['ghcr.io']).toBeDefined();
      const decoded = Buffer.from(
        config.auths['ghcr.io'].auth,
        'base64',
      ).toString();
      expect(decoded).toBe('user:pass');
    });

    it('should handle multiple registries', async () => {
      mockCore.createNamespacedSecret.mockResolvedValue(undefined);

      await service.createRunSecret('run-1', [
        { registryUrl: 'ghcr.io', username: 'u1', password: 'p1' },
        { registryUrl: 'docker.io', username: 'u2', password: 'p2' },
      ]);

      const configJson = Buffer.from(
        mockCore.createNamespacedSecret.mock.calls[0][0].body.data[
          '.dockerconfigjson'
        ],
        'base64',
      ).toString();
      const config = JSON.parse(configJson);
      expect(Object.keys(config.auths)).toHaveLength(2);
      expect(config.auths['ghcr.io']).toBeDefined();
      expect(config.auths['docker.io']).toBeDefined();
    });

    it('should suppress 409 conflict', async () => {
      mockCore.createNamespacedSecret.mockRejectedValue({ code: 409 });

      await expect(
        service.createRunSecret('run-1', [
          { registryUrl: 'ghcr.io', username: 'u', password: 'p' },
        ]),
      ).resolves.toBeUndefined();
    });

    it('should re-throw non-409 errors', async () => {
      mockCore.createNamespacedSecret.mockRejectedValue({ code: 500 });

      await expect(
        service.createRunSecret('run-1', [
          { registryUrl: 'ghcr.io', username: 'u', password: 'p' },
        ]),
      ).rejects.toEqual({ code: 500 });
    });
  });

  describe('copyToNamespace', () => {
    it('should copy secret and patch service account', async () => {
      mockCore.readNamespacedSecret.mockResolvedValue({
        data: { '.dockerconfigjson': 'encoded-data' },
      });
      mockCore.createNamespacedSecret.mockResolvedValue(undefined);
      mockCore.readNamespacedServiceAccount.mockResolvedValue({
        imagePullSecrets: [],
      });
      mockCore.replaceNamespacedServiceAccount.mockResolvedValue(undefined);

      await service.copyToNamespace('run-1', 'test-ns');

      expect(mockCore.createNamespacedSecret).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: 'test-ns',
          body: expect.objectContaining({
            metadata: expect.objectContaining({ name: 'registry-creds' }),
            type: 'kubernetes.io/dockerconfigjson',
          }),
        }),
      );
      expect(mockCore.replaceNamespacedServiceAccount).toHaveBeenCalled();
    });

    it('should return silently when source secret is not found (404)', async () => {
      mockCore.readNamespacedSecret.mockRejectedValue({ code: 404 });

      await service.copyToNamespace('run-1', 'test-ns');

      expect(mockCore.createNamespacedSecret).not.toHaveBeenCalled();
    });

    it('should return when source data is null', async () => {
      mockCore.readNamespacedSecret.mockResolvedValue({ data: null });

      await service.copyToNamespace('run-1', 'test-ns');

      expect(mockCore.createNamespacedSecret).not.toHaveBeenCalled();
    });

    it('should suppress 409 on target secret creation and continue', async () => {
      mockCore.readNamespacedSecret.mockResolvedValue({
        data: { '.dockerconfigjson': 'encoded' },
      });
      mockCore.createNamespacedSecret.mockRejectedValue({ code: 409 });
      mockCore.readNamespacedServiceAccount.mockResolvedValue({
        imagePullSecrets: [{ name: 'registry-creds' }],
      });

      await expect(
        service.copyToNamespace('run-1', 'test-ns'),
      ).resolves.toBeUndefined();
    });

    it('should not patch SA when imagePullSecrets already contains the secret', async () => {
      mockCore.readNamespacedSecret.mockResolvedValue({
        data: { '.dockerconfigjson': 'encoded' },
      });
      mockCore.createNamespacedSecret.mockResolvedValue(undefined);
      mockCore.readNamespacedServiceAccount.mockResolvedValue({
        imagePullSecrets: [{ name: 'registry-creds' }],
      });

      await service.copyToNamespace('run-1', 'test-ns');

      expect(mockCore.replaceNamespacedServiceAccount).not.toHaveBeenCalled();
    });

    it('should retry SA patching on 404', async () => {
      mockCore.readNamespacedSecret.mockResolvedValue({
        data: { '.dockerconfigjson': 'encoded' },
      });
      mockCore.createNamespacedSecret.mockResolvedValue(undefined);
      mockCore.readNamespacedServiceAccount
        .mockRejectedValueOnce({ code: 404 })
        .mockResolvedValue({ imagePullSecrets: [] });
      mockCore.replaceNamespacedServiceAccount.mockResolvedValue(undefined);

      await service.copyToNamespace('run-1', 'test-ns');

      expect(mockCore.readNamespacedServiceAccount).toHaveBeenCalledTimes(2);
    });
  });

  describe('deleteRunSecret', () => {
    it('should delete the secret', async () => {
      mockCore.deleteNamespacedSecret.mockResolvedValue(undefined);

      await service.deleteRunSecret('run-1');

      expect(mockCore.deleteNamespacedSecret).toHaveBeenCalledWith({
        name: 'run-run-1-registry-creds',
        namespace: 'dokkimi-system',
      });
    });

    it('should return silently when secret is already gone (404)', async () => {
      mockCore.deleteNamespacedSecret.mockRejectedValue({ code: 404 });

      await expect(service.deleteRunSecret('run-1')).resolves.toBeUndefined();
    });

    it('should re-throw non-404 errors', async () => {
      mockCore.deleteNamespacedSecret.mockRejectedValue({ code: 500 });

      await expect(service.deleteRunSecret('run-1')).rejects.toEqual({
        code: 500,
      });
    });
  });

  describe('deleteAllRegistrySecrets', () => {
    it('should delete all matching secrets', async () => {
      mockCore.listNamespacedSecret.mockResolvedValue({
        items: [
          { metadata: { name: 'run-a-registry-creds' } },
          { metadata: { name: 'run-b-registry-creds' } },
        ],
      });
      mockCore.deleteNamespacedSecret.mockResolvedValue(undefined);

      await service.deleteAllRegistrySecrets();

      expect(mockCore.deleteNamespacedSecret).toHaveBeenCalledTimes(2);
    });

    it('should suppress 404 on individual delete', async () => {
      mockCore.listNamespacedSecret.mockResolvedValue({
        items: [{ metadata: { name: 'run-a-registry-creds' } }],
      });
      mockCore.deleteNamespacedSecret.mockRejectedValue({ code: 404 });

      await expect(service.deleteAllRegistrySecrets()).resolves.toBeUndefined();
    });

    it('should skip items with no metadata name', async () => {
      mockCore.listNamespacedSecret.mockResolvedValue({
        items: [{ metadata: {} }, { metadata: { name: 'valid' } }],
      });
      mockCore.deleteNamespacedSecret.mockResolvedValue(undefined);

      await service.deleteAllRegistrySecrets();

      expect(mockCore.deleteNamespacedSecret).toHaveBeenCalledTimes(1);
    });

    it('should handle list failure gracefully', async () => {
      mockCore.listNamespacedSecret.mockRejectedValue(new Error('fail'));

      await expect(service.deleteAllRegistrySecrets()).resolves.toBeUndefined();
    });
  });

  describe('hasRunSecret', () => {
    it('should return true when the secret exists', async () => {
      mockCore.readNamespacedSecret.mockResolvedValue({});

      expect(await service.hasRunSecret('run-1')).toBe(true);
    });

    it('should return false when the secret is missing (404)', async () => {
      mockCore.readNamespacedSecret.mockRejectedValue({ code: 404 });

      expect(await service.hasRunSecret('run-1')).toBe(false);
    });

    it('should re-throw non-404 errors', async () => {
      mockCore.readNamespacedSecret.mockRejectedValue({ code: 500 });

      await expect(service.hasRunSecret('run-1')).rejects.toEqual({
        code: 500,
      });
    });
  });
});
