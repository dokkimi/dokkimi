import { Test, TestingModule } from '@nestjs/testing';
import { ConfigMapBuilderService } from './configmap-builder.service';
import type { ServiceInfo } from './configmap-builder.service';

describe('ConfigMapBuilderService', () => {
  let service: ConfigMapBuilderService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ConfigMapBuilderService],
    }).compile();

    service = module.get<ConfigMapBuilderService>(ConfigMapBuilderService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('buildInterceptorConfigMap', () => {
    const namespace = 'dokkimi-test-namespace';

    it('should build ConfigMap with services in urlMap', () => {
      const items = [
        {
          id: 'item-1',
          type: 'SERVICE' as const,
          containerName: 'test-service',
          name: 'Test Service',
          port: 8080,
          domain: 'test.example.com',
        },
        {
          id: 'item-2',
          type: 'SERVICE' as const,
          containerName: 'another-service',
          name: 'Another Service',
          port: 9090,
          domain: null,
        },
      ];

      const mocks = [
        {
          method: 'GET',
          origin: 'test-service',
          target: '*',
          path: '/api/test',
        },
      ];

      const configMap = service.buildInterceptorConfigMap(
        namespace,
        items,
        mocks,
      );

      expect(configMap.metadata?.name).toBe('dokkimi-interceptor-config');
      expect(configMap.metadata?.namespace).toBe(namespace);
      expect(configMap.metadata?.labels).toEqual({
        'app.dokkimi.io/name': 'dokkimi',
        'app.dokkimi.io/component': 'interceptor-config',
      });

      const urlMap = JSON.parse(configMap.data?.urlMap || '{}') as Record<
        string,
        ServiceInfo
      >;
      expect(urlMap['test-service']).toEqual({
        scheme: 'http',
        url: 'http://test-service',
        name: 'Test Service',
        port: 8080,
        instanceItemId: 'item-1',
      });
      expect(urlMap['test.example.com']).toEqual({
        scheme: 'https',
        url: 'https://test.example.com',
        name: 'Test Service',
        instanceItemId: 'item-1',
      });
      expect(urlMap['another-service']).toEqual({
        scheme: 'http',
        url: 'http://another-service',
        name: 'Another Service',
        port: 9090,
        instanceItemId: 'item-2',
      });

      const httpMocks = JSON.parse(
        configMap.data?.httpMocks || '[]',
      ) as typeof mocks;
      expect(httpMocks).toEqual(mocks);
    });

    it('should exclude non-service items from urlMap', () => {
      const items = [
        {
          id: 'item-1',
          type: 'SERVICE' as const,
          containerName: 'test-service',
          name: 'Test Service',
          port: 8080,
          domain: null,
        },
        {
          id: 'item-2',
          type: 'DATABASE' as const,
          containerName: 'test-db',
          name: 'Test DB',
          port: null,
          domain: null,
        },
      ];

      const configMap = service.buildInterceptorConfigMap(namespace, items, []);

      const urlMap = JSON.parse(configMap.data?.urlMap || '{}') as Record<
        string,
        ServiceInfo
      >;
      expect(urlMap['test-service']).toBeDefined();
      expect(urlMap['test-db']).toBeUndefined();
    });

    it('should build databaseMap for database items', () => {
      const items = [
        {
          id: 'item-1',
          type: 'SERVICE' as const,
          containerName: 'test-service',
          name: 'Test Service',
          port: 8080,
          domain: null,
        },
        {
          id: 'item-2',
          type: 'DATABASE' as const,
          containerName: 'postgres-db',
          name: 'PostgreSQL DB',
          database: 'postgres',
          port: null,
          domain: null,
        },
        {
          id: 'item-3',
          type: 'DATABASE' as const,
          containerName: 'mysql-db',
          name: 'MySQL DB',
          database: 'mysql',
          port: null,
          domain: null,
        },
        {
          id: 'item-4',
          type: 'DATABASE' as const,
          containerName: 'mongo-db',
          name: 'MongoDB',
          database: 'mongodb',
          port: null,
          domain: null,
        },
      ];

      const configMap = service.buildInterceptorConfigMap(namespace, items, []);

      const databaseMap = JSON.parse(
        configMap.data?.databaseMap || '{}',
      ) as Record<string, any>;

      expect(databaseMap['postgres-db']).toBeDefined();
      expect(databaseMap['postgres-db']).toEqual({
        type: 'postgresql',
        user: 'dokkimi',
        password: 'dokkimi',
        database: 'dokkimi',
        port: 5432,
        instanceItemId: 'item-2',
      });

      expect(databaseMap['mysql-db']).toBeDefined();
      expect(databaseMap['mysql-db']).toEqual({
        type: 'mysql',
        user: 'dokkimi',
        password: 'dokkimi',
        database: 'dokkimi',
        port: 3306,
        instanceItemId: 'item-3',
      });

      expect(databaseMap['mongo-db']).toBeDefined();
      expect(databaseMap['mongo-db']).toEqual({
        type: 'mongodb',
        user: 'dokkimi',
        password: 'dokkimi',
        database: 'dokkimi',
        port: 27017,
        instanceItemId: 'item-4',
      });
    });

    it('should normalize database types in databaseMap', () => {
      const items = [
        {
          id: 'item-1',
          type: 'DATABASE' as const,
          containerName: 'postgres-db',
          name: 'Postgres DB',
          database: 'postgres', // Should normalize to postgresql
          port: null,
          domain: null,
        },
        {
          id: 'item-2',
          type: 'DATABASE' as const,
          containerName: 'mongo-db',
          name: 'Mongo DB',
          database: 'mongodb',
          port: null,
          domain: null,
        },
        {
          id: 'item-3',
          type: 'DATABASE' as const,
          containerName: 'mariadb-db',
          name: 'MariaDB',
          database: 'mariadb', // Should normalize to mysql
          port: null,
          domain: null,
        },
      ];

      const configMap = service.buildInterceptorConfigMap(namespace, items, []);

      const databaseMap = JSON.parse(
        configMap.data?.databaseMap || '{}',
      ) as Record<string, any>;

      expect(databaseMap['postgres-db'].type).toBe('postgresql');
      expect(databaseMap['mongo-db'].type).toBe('mongodb');
      expect(databaseMap['mariadb-db'].type).toBe('mysql');
    });

    it('should not include databaseMap if no databases present', () => {
      const items = [
        {
          id: 'item-1',
          type: 'SERVICE' as const,
          containerName: 'test-service',
          name: 'Test Service',
          port: 8080,
          domain: null,
        },
      ];

      const configMap = service.buildInterceptorConfigMap(namespace, items, []);

      expect(configMap.data?.databaseMap).toBeUndefined();
    });

    it('should exclude databases without containerName or id', () => {
      const items = [
        {
          id: 'item-1',
          type: 'DATABASE' as const,
          containerName: undefined as unknown as string, // Missing containerName
          name: 'Test DB',
          database: 'postgres',
          port: null,
          domain: null,
        },
        {
          id: undefined, // Missing id
          type: 'DATABASE' as const,
          containerName: 'another-db',
          name: 'Another DB',
          database: 'mysql',
          port: null,
          domain: null,
        },
        {
          id: 'item-3',
          type: 'DATABASE' as const,
          containerName: 'valid-db',
          name: 'Valid DB',
          database: 'postgresql',
          port: null,
          domain: null,
        },
      ];

      const configMap = service.buildInterceptorConfigMap(namespace, items, []);

      const databaseMap = JSON.parse(
        configMap.data?.databaseMap || '{}',
      ) as Record<string, any>;

      expect(databaseMap['test-db']).toBeUndefined();
      expect(databaseMap['another-db']).toBeUndefined();
      expect(databaseMap['valid-db']).toBeDefined();
    });

    it('should exclude services without containerName or port', () => {
      const items = [
        {
          id: 'item-1',
          type: 'SERVICE' as const,
          containerName: undefined as unknown as string,
          name: 'Test Service',
          port: 8080,
          domain: null,
        },
        {
          id: 'item-2',
          type: 'SERVICE' as const,
          containerName: 'another-service',
          name: 'Another Service',
          port: null,
          domain: null,
        },
        {
          id: 'item-3',
          type: 'SERVICE' as const,
          containerName: 'valid-service',
          name: 'Valid Service',
          port: 9090,
          domain: null,
        },
      ];

      const configMap = service.buildInterceptorConfigMap(namespace, items, []);

      const urlMap = JSON.parse(configMap.data?.urlMap || '{}') as Record<
        string,
        ServiceInfo
      >;
      expect(urlMap['test-service']).toBeUndefined();
      expect(urlMap['another-service']).toBeUndefined();
      expect(urlMap['valid-service']).toBeDefined();
    });

    it('should handle empty items array', () => {
      const configMap = service.buildInterceptorConfigMap(namespace, [], []);

      const urlMap = JSON.parse(configMap.data?.urlMap || '{}') as Record<
        string,
        ServiceInfo
      >;
      expect(Object.keys(urlMap)).toHaveLength(0);

      const httpMocks = JSON.parse(
        configMap.data?.httpMocks || '[]',
      ) as unknown[];
      expect(httpMocks).toEqual([]);
    });

    it('should handle empty mocks array', () => {
      const items = [
        {
          id: 'item-1',
          type: 'SERVICE' as const,
          containerName: 'test-service',
          name: 'Test Service',
          port: 8080,
          domain: null,
        },
      ];

      const configMap = service.buildInterceptorConfigMap(namespace, items, []);

      const httpMocks = JSON.parse(
        configMap.data?.httpMocks || '[]',
      ) as unknown[];
      expect(httpMocks).toEqual([]);
    });

    it('should include domain mapping when domain is provided', () => {
      const items = [
        {
          id: 'item-1',
          type: 'SERVICE' as const,
          containerName: 'test-service',
          name: 'Test Service',
          port: 8080,
          domain: 'api.example.com',
        },
      ];

      const configMap = service.buildInterceptorConfigMap(namespace, items, []);

      const urlMap = JSON.parse(configMap.data?.urlMap || '{}') as Record<
        string,
        ServiceInfo
      >;
      expect(urlMap['test-service']).toBeDefined();
      expect(urlMap['api.example.com']).toEqual({
        scheme: 'https',
        url: 'https://api.example.com',
        name: 'Test Service',
        instanceItemId: 'item-1',
      });
    });

    it('should not include domain mapping when domain is null', () => {
      const items = [
        {
          id: 'item-1',
          type: 'SERVICE' as const,
          containerName: 'test-service',
          name: 'Test Service',
          port: 8080,
          domain: null,
        },
      ];

      const configMap = service.buildInterceptorConfigMap(namespace, items, []);

      const urlMap = JSON.parse(configMap.data?.urlMap || '{}') as Record<
        string,
        ServiceInfo
      >;
      expect(urlMap['test-service']).toBeDefined();
      expect(urlMap['api.example.com']).toBeUndefined();
    });
  });

  describe('buildInterceptorConfigMap - podNameToNamespaceItemId', () => {
    const namespace = 'dokkimi-test-namespace';

    it('should build podNameToNamespaceItemId mapping for all items with containerName and id', () => {
      const items = [
        {
          id: 'item-1',
          type: 'SERVICE' as const,
          containerName: 'svc-one',
          name: 'Service One',
          port: 8080,
          domain: null,
        },
        {
          id: 'item-2',
          type: 'DATABASE' as const,
          containerName: 'db-one',
          name: 'DB One',
          database: 'postgres',
          port: null,
          domain: null,
        },
      ];

      const configMap = service.buildInterceptorConfigMap(namespace, items, []);

      const podMap = JSON.parse(
        configMap.data?.podNameToNamespaceItemId || '{}',
      ) as Record<string, string>;
      expect(podMap['svc-one']).toBe('item-1');
      expect(podMap['db-one']).toBe('item-2');
    });

    it('should skip items missing containerName or id from podNameToNamespaceItemId', () => {
      const items = [
        {
          id: undefined,
          type: 'SERVICE' as const,
          containerName: 'no-id-svc',
          name: 'No ID',
          port: 8080,
          domain: null,
        },
        {
          id: 'item-2',
          type: 'SERVICE' as const,
          containerName: undefined as unknown as string,
          name: 'No ContainerName',
          port: 8080,
          domain: null,
        },
        {
          id: 'item-3',
          type: 'SERVICE' as const,
          containerName: 'valid-svc',
          name: 'Valid',
          port: 8080,
          domain: null,
        },
      ];

      const configMap = service.buildInterceptorConfigMap(namespace, items, []);

      const podMap = JSON.parse(
        configMap.data?.podNameToNamespaceItemId || '{}',
      ) as Record<string, string>;
      expect(podMap['no-id-svc']).toBeUndefined();
      expect(podMap['valid-svc']).toBe('item-3');
      expect(Object.keys(podMap)).toHaveLength(1);
    });
  });

  describe('buildInterceptorConfigMap - testConfig', () => {
    const namespace = 'dokkimi-test-namespace';

    it('should include testConfig when provided', () => {
      const testConfig = {
        testRunId: 'run-123',
        callbackUrl: 'http://localhost:19001/test-complete',
        timeoutSeconds: 60,
        executionMode: 'sequential',
        tests: [{ name: 'test-1', steps: [] }],
        variables: { BASE_URL: 'http://svc' },
      };

      const configMap = service.buildInterceptorConfigMap(
        namespace,
        [],
        [],
        undefined,
        testConfig,
      );

      const parsed = JSON.parse(configMap.data?.testConfig || '{}');
      expect(parsed.testRunId).toBe('run-123');
      expect(parsed.callbackUrl).toBe('http://localhost:19001/test-complete');
      expect(parsed.timeoutSeconds).toBe(60);
      expect(parsed.executionMode).toBe('sequential');
      expect(parsed.tests).toEqual([{ name: 'test-1', steps: [] }]);
      expect(parsed.variables).toEqual({ BASE_URL: 'http://svc' });
    });

    it('should not include testConfig when not provided', () => {
      const configMap = service.buildInterceptorConfigMap(namespace, [], []);

      expect(configMap.data?.testConfig).toBeUndefined();
    });
  });

  describe('buildInterceptorConfigMap - expectedNamespaceItemIds', () => {
    const namespace = 'dokkimi-test-namespace';

    it('should include expectedNamespaceItemIds when provided with values', () => {
      const ids = ['item-1', 'item-2', 'item-3'];

      const configMap = service.buildInterceptorConfigMap(
        namespace,
        [],
        [],
        undefined,
        undefined,
        ids,
      );

      const parsed = JSON.parse(
        configMap.data?.expectedNamespaceItemIds || '[]',
      );
      expect(parsed).toEqual(ids);
    });

    it('should not include expectedNamespaceItemIds when array is empty', () => {
      const configMap = service.buildInterceptorConfigMap(
        namespace,
        [],
        [],
        undefined,
        undefined,
        [],
      );

      expect(configMap.data?.expectedNamespaceItemIds).toBeUndefined();
    });

    it('should not include expectedNamespaceItemIds when not provided', () => {
      const configMap = service.buildInterceptorConfigMap(namespace, [], []);

      expect(configMap.data?.expectedNamespaceItemIds).toBeUndefined();
    });
  });

  describe('buildInterceptorConfigMap - database credentials', () => {
    const namespace = 'dokkimi-test-namespace';

    it('should use custom database credentials when provided', () => {
      const items = [
        {
          id: 'item-1',
          type: 'DATABASE' as const,
          containerName: 'custom-db',
          name: 'Custom DB',
          database: 'postgres',
          dbName: 'mydb',
          dbUser: 'myuser',
          dbPassword: 'mypass',
          port: null,
          domain: null,
        },
      ];

      const configMap = service.buildInterceptorConfigMap(namespace, items, []);

      const databaseMap = JSON.parse(
        configMap.data?.databaseMap || '{}',
      ) as Record<string, any>;
      expect(databaseMap['custom-db']).toEqual({
        type: 'postgresql',
        user: 'myuser',
        password: 'mypass',
        database: 'mydb',
        port: 5432,
        instanceItemId: 'item-1',
      });
    });

    it('should default database type to postgres when database field is missing', () => {
      const items = [
        {
          id: 'item-1',
          type: 'DATABASE' as const,
          containerName: 'no-type-db',
          name: 'No Type DB',
          port: null,
          domain: null,
        },
      ];

      const configMap = service.buildInterceptorConfigMap(namespace, items, []);

      const databaseMap = JSON.parse(
        configMap.data?.databaseMap || '{}',
      ) as Record<string, any>;
      expect(databaseMap['no-type-db'].type).toBe('postgresql');
    });

    it('should normalize redis database type as-is', () => {
      const items = [
        {
          id: 'item-1',
          type: 'DATABASE' as const,
          containerName: 'redis-db',
          name: 'Redis',
          database: 'redis',
          port: null,
          domain: null,
        },
      ];

      const configMap = service.buildInterceptorConfigMap(namespace, items, []);

      const databaseMap = JSON.parse(
        configMap.data?.databaseMap || '{}',
      ) as Record<string, any>;
      expect(databaseMap['redis-db'].type).toBe('redis');
    });
  });

  describe('buildInterceptorConfigMap - mocks default', () => {
    const namespace = 'dokkimi-test-namespace';

    it('should default mocks to empty array when omitted', () => {
      const configMap = service.buildInterceptorConfigMap(namespace, []);

      const httpMocks = JSON.parse(
        configMap.data?.httpMocks || '[]',
      ) as unknown[];
      expect(httpMocks).toEqual([]);
    });
  });

  describe('buildDbCredentialsConfigMap', () => {
    const namespace = 'dokkimi-test-namespace';

    it('should build credentials ConfigMap with correct metadata', () => {
      const databases = [{ name: 'My DB', containerName: 'my-db' }];

      const configMap = service.buildDbCredentialsConfigMap(
        namespace,
        databases,
      );

      expect(configMap.metadata?.name).toBe('dokkimi-db-credentials');
      expect(configMap.metadata?.namespace).toBe(namespace);
      expect(configMap.metadata?.labels).toEqual({
        'app.dokkimi.io/name': 'dokkimi',
        'app.dokkimi.io/component': 'db-credentials',
      });
    });

    it('should use config defaults when db credentials are not provided', () => {
      const databases = [{ name: 'Default DB', containerName: 'default-db' }];

      const configMap = service.buildDbCredentialsConfigMap(
        namespace,
        databases,
      );

      const credentials = JSON.parse(
        configMap.data?.['credentials.json'] || '{}',
      ) as Record<string, any>;
      expect(credentials['default-db']).toEqual({
        dbName: 'dokkimi',
        dbUser: 'dokkimi',
        dbPassword: 'dokkimi',
      });
    });

    it('should use custom credentials when provided', () => {
      const databases = [
        {
          name: 'Custom DB',
          containerName: 'custom-db',
          dbName: 'production',
          dbUser: 'admin',
          dbPassword: 'secret123',
        },
      ];

      const configMap = service.buildDbCredentialsConfigMap(
        namespace,
        databases,
      );

      const credentials = JSON.parse(
        configMap.data?.['credentials.json'] || '{}',
      ) as Record<string, any>;
      expect(credentials['custom-db']).toEqual({
        dbName: 'production',
        dbUser: 'admin',
        dbPassword: 'secret123',
      });
    });

    it('should handle multiple databases with mixed credentials', () => {
      const databases = [
        { name: 'DB 1', containerName: 'db-one', dbName: 'custom_db' },
        { name: 'DB 2', containerName: 'db-two' },
        {
          name: 'DB 3',
          containerName: 'db-three',
          dbUser: 'custom_user',
          dbPassword: 'custom_pass',
        },
      ];

      const configMap = service.buildDbCredentialsConfigMap(
        namespace,
        databases,
      );

      const credentials = JSON.parse(
        configMap.data?.['credentials.json'] || '{}',
      ) as Record<string, any>;

      expect(credentials['db-one'].dbName).toBe('custom_db');
      expect(credentials['db-one'].dbUser).toBe('dokkimi');
      expect(credentials['db-one'].dbPassword).toBe('dokkimi');

      expect(credentials['db-two'].dbName).toBe('dokkimi');
      expect(credentials['db-two'].dbUser).toBe('dokkimi');
      expect(credentials['db-two'].dbPassword).toBe('dokkimi');

      expect(credentials['db-three'].dbName).toBe('dokkimi');
      expect(credentials['db-three'].dbUser).toBe('custom_user');
      expect(credentials['db-three'].dbPassword).toBe('custom_pass');
    });
  });
});
