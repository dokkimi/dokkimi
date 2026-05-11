import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseDeploymentBuilderService } from './database-deployment-builder.service';
import { DOKKIMI_IMAGES } from '../../constants/image-tags';

describe('DatabaseDeploymentBuilderService', () => {
  let databaseBuilder: DatabaseDeploymentBuilderService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DatabaseDeploymentBuilderService],
    }).compile();

    databaseBuilder = module.get<DatabaseDeploymentBuilderService>(
      DatabaseDeploymentBuilderService,
    );
    jest.clearAllMocks();
  });

  // ─── helpers ──────────────────────────────────────────────────────

  function makeDbItem(overrides: Record<string, unknown> = {}) {
    return {
      id: 'item-1',
      name: 'Postgres DB',
      k8sName: 'postgres-db',
      type: 'DATABASE' as const,
      database: 'postgres',
      initFiles: null,
      ...overrides,
    };
  }

  function makeDbConfig(overrides: Record<string, unknown> = {}) {
    return {
      image: 'postgres:15',
      environment: { POSTGRES_DB: 'dokkimi', POSTGRES_USER: 'dokkimi' },
      ports: [5432],
      volumeMounts: [] as any[],
      volumes: [] as any[],
      ...overrides,
    };
  }

  // ─── buildDatabaseDeployment ──────────────────────────────────────

  describe('buildDatabaseDeployment', () => {
    it('should build a database deployment with db-proxy and fluent-bit', () => {
      const item = makeDbItem();
      const dbConfig = makeDbConfig({
        volumeMounts: [
          { name: 'postgres-data', mountPath: '/var/lib/postgresql/data' },
        ],
        volumes: [{ name: 'postgres-data', emptyDir: {} }],
      });

      const deployment = databaseBuilder.buildDatabaseDeployment(
        item,
        'test-namespace',
        'instance-1',
        'item-1',
        dbConfig,
      );

      expect(deployment.metadata!.name).toBe('postgres-db');

      // 3 containers: main + db-proxy + fluent-bit
      const containers = deployment.spec!.template.spec!.containers;
      expect(containers).toHaveLength(3);

      // Main container
      expect(containers[0].name).toBe('postgres-db');
      expect(containers[0].image).toBe('postgres:15');
      expect(containers[0].env).toHaveLength(2);
      expect(containers[0].ports).toEqual([{ containerPort: 5432 }]);

      // db-proxy sidecar
      expect(containers[1].name).toBe('db-proxy');
      expect(containers[1].image).toBe(DOKKIMI_IMAGES.dbProxyPostgres);
      expect(containers[1].ports).toEqual([
        { containerPort: 15432, name: 'query' },
      ]);

      // db-proxy env vars
      const dbProxyEnv = containers[1].env!;
      const findEnv = (name: string) => dbProxyEnv.find((e) => e.name === name);
      expect(findEnv('DATABASE_TYPE')?.value).toBe('postgres');
      expect(findEnv('DATABASE_PORT')?.value).toBe('5432');
      expect(findEnv('INSTANCE_ITEM_NAME')?.value).toBe('Postgres DB');
      expect(findEnv('NAMESPACE')?.value).toBe('instance-1');

      // fluent-bit sidecar
      expect(containers[2].name).toBe('fluent-bit');
      const fbEnv = containers[2].env!;
      expect(fbEnv).toContainEqual({
        name: 'INSTANCE_ID',
        value: 'instance-1',
      });
      expect(fbEnv).toContainEqual({
        name: 'INSTANCE_ITEM_ID',
        value: 'item-1',
      });
    });

    it('should select correct db-proxy image for MySQL', () => {
      const item = makeDbItem({ database: 'mysql', k8sName: 'mysql-db' });
      const dbConfig = makeDbConfig({
        image: 'mysql:8',
        environment: { MYSQL_DATABASE: 'dokkimi' },
        ports: [3306],
      });

      const deployment = databaseBuilder.buildDatabaseDeployment(
        item,
        'test-namespace',
        'instance-1',
        'item-1',
        dbConfig,
      );

      expect(deployment.spec!.template.spec!.containers[1].image).toBe(
        DOKKIMI_IMAGES.dbProxyMysql,
      );
    });

    it('should select correct db-proxy image for MariaDB', () => {
      const item = makeDbItem({ database: 'mariadb', k8sName: 'maria-db' });
      const dbConfig = makeDbConfig({ image: 'mariadb:11', ports: [3306] });

      const deployment = databaseBuilder.buildDatabaseDeployment(
        item,
        'test-namespace',
        'instance-1',
        'item-1',
        dbConfig,
      );

      expect(deployment.spec!.template.spec!.containers[1].image).toBe(
        DOKKIMI_IMAGES.dbProxyMysql,
      );
    });

    it('should select correct db-proxy image for MongoDB', () => {
      const item = makeDbItem({ database: 'mongodb', k8sName: 'mongo-db' });
      const dbConfig = makeDbConfig({
        image: 'mongo:7',
        environment: {},
        ports: [27017],
      });

      const deployment = databaseBuilder.buildDatabaseDeployment(
        item,
        'test-namespace',
        'instance-1',
        'item-1',
        dbConfig,
      );

      expect(deployment.spec!.template.spec!.containers[1].image).toBe(
        DOKKIMI_IMAGES.dbProxyMongo,
      );
    });

    it('should select correct db-proxy image for Redis', () => {
      const item = makeDbItem({ database: 'redis', k8sName: 'redis-cache' });
      const dbConfig = makeDbConfig({
        image: 'redis:7',
        environment: {},
        ports: [6379],
      });

      const deployment = databaseBuilder.buildDatabaseDeployment(
        item,
        'test-namespace',
        'instance-1',
        'item-1',
        dbConfig,
      );

      expect(deployment.spec!.template.spec!.containers[1].image).toBe(
        DOKKIMI_IMAGES.dbProxyRedis,
      );
    });

    it('should throw error for unsupported database type', () => {
      const item = makeDbItem({ database: 'unknown', k8sName: 'unknown-db' });
      const dbConfig = makeDbConfig({
        image: 'unknown:latest',
        environment: {},
        ports: [1234],
      });

      expect(() => {
        databaseBuilder.buildDatabaseDeployment(
          item,
          'test-namespace',
          'instance-1',
          'item-1',
          dbConfig,
        );
      }).toThrow('Unsupported database type for db-proxy: unknown');
    });

    it('should throw error when database type is null', () => {
      const item = makeDbItem({ database: null, k8sName: 'no-db' });
      const dbConfig = makeDbConfig({ ports: [5432] });

      expect(() => {
        databaseBuilder.buildDatabaseDeployment(
          item,
          'test-namespace',
          'instance-1',
          'item-1',
          dbConfig,
        );
      }).toThrow('Database type is required for db-proxy');
    });

    it('should mount init files via emptyDir + init container when initFiles array is provided', () => {
      const item = makeDbItem({
        initFiles: [
          { filename: '00_schema.sql', dbType: 'postgres', order: 0 },
          { filename: '01_data.sql', dbType: 'postgres', order: 1 },
        ],
      });
      const dbConfig = makeDbConfig();

      const deployment = databaseBuilder.buildDatabaseDeployment(
        item,
        'test-namespace',
        'instance-1',
        'item-1',
        dbConfig,
      );

      const container = deployment.spec!.template.spec!.containers[0];
      const initMount = container.volumeMounts?.find(
        (vm) => vm.name === 'init-files',
      );
      expect(initMount).toBeDefined();
      expect(initMount?.mountPath).toBe('/docker-entrypoint-initdb.d');
      expect(initMount?.readOnly).toBe(true);

      const volumes = deployment.spec!.template.spec!.volumes!;
      const initVolume = volumes.find((v) => v.name === 'init-files');
      expect(initVolume).toBeDefined();
      expect(initVolume?.emptyDir).toEqual({});

      const initContainers = deployment.spec!.template.spec!.initContainers!;
      expect(initContainers).toHaveLength(1);
      expect(initContainers[0].name).toBe('fetch-init-files');
      expect(initContainers[0].image).toBe(DOKKIMI_IMAGES.initFetcher);
      expect(initContainers[0].args![0]).toContain(
        '/init-files/instance-1/Postgres%20DB',
      );
    });

    it('should not mount init files when initFiles is null', () => {
      const item = makeDbItem({ initFiles: null });
      const dbConfig = makeDbConfig();

      const deployment = databaseBuilder.buildDatabaseDeployment(
        item,
        'test-namespace',
        'instance-1',
        'item-1',
        dbConfig,
      );

      const container = deployment.spec!.template.spec!.containers[0];
      const initMount = container.volumeMounts?.find(
        (vm) => vm.name === 'init-files',
      );
      expect(initMount).toBeUndefined();
    });

    it('should not mount init files when initFiles is empty', () => {
      const item = makeDbItem({ initFiles: [] });
      const dbConfig = makeDbConfig();

      const deployment = databaseBuilder.buildDatabaseDeployment(
        item,
        'test-namespace',
        'instance-1',
        'item-1',
        dbConfig,
      );

      const container = deployment.spec!.template.spec!.containers[0];
      const initMount = container.volumeMounts?.find(
        (vm) => vm.name === 'init-files',
      );
      expect(initMount).toBeUndefined();
    });

    it('should use correct init mount path for MySQL', () => {
      const item = makeDbItem({
        database: 'mysql',
        k8sName: 'mysql-db',
        initFiles: [{ filename: 'init.sql', dbType: 'mysql', order: 0 }],
      });
      const dbConfig = makeDbConfig({
        image: 'mysql:8',
        ports: [3306],
      });

      const deployment = databaseBuilder.buildDatabaseDeployment(
        item,
        'test-namespace',
        'instance-1',
        'item-1',
        dbConfig,
      );

      const container = deployment.spec!.template.spec!.containers[0];
      const initMount = container.volumeMounts?.find(
        (vm) => vm.name === 'init-files',
      );
      expect(initMount?.mountPath).toBe('/docker-entrypoint-initdb.d');
    });

    it('should use correct init mount path for MongoDB', () => {
      const item = makeDbItem({
        database: 'mongodb',
        k8sName: 'mongo-db',
        initFiles: [{ filename: 'init.js', dbType: 'mongodb', order: 0 }],
      });
      const dbConfig = makeDbConfig({
        image: 'mongo:7',
        environment: {},
        ports: [27017],
      });

      const deployment = databaseBuilder.buildDatabaseDeployment(
        item,
        'test-namespace',
        'instance-1',
        'item-1',
        dbConfig,
      );

      const container = deployment.spec!.template.spec!.containers[0];
      const initMount = container.volumeMounts?.find(
        (vm) => vm.name === 'init-files',
      );
      expect(initMount?.mountPath).toBe('/docker-entrypoint-initdb.d');
    });

    it('should not mount init files for Redis', () => {
      const item = makeDbItem({
        database: 'redis',
        k8sName: 'redis-cache',
        initFiles: [{ filename: 'init.lua', dbType: 'redis', order: 0 }],
      });
      const dbConfig = makeDbConfig({
        image: 'redis:7',
        environment: {},
        ports: [6379],
      });

      const deployment = databaseBuilder.buildDatabaseDeployment(
        item,
        'test-namespace',
        'instance-1',
        'item-1',
        dbConfig,
      );

      const container = deployment.spec!.template.spec!.containers[0];
      const initMount = container.volumeMounts?.find(
        (vm) => vm.name === 'init-files',
      );
      expect(initMount).toBeUndefined();
    });

    it('should include command when dbConfig has one', () => {
      const item = makeDbItem();
      const dbConfig = makeDbConfig({
        command: ['postgres', '-c', 'max_connections=200'],
      });

      const deployment = databaseBuilder.buildDatabaseDeployment(
        item,
        'test-namespace',
        'instance-1',
        'item-1',
        dbConfig,
      );

      expect(deployment.spec!.template.spec!.containers[0].command).toEqual([
        'postgres',
        '-c',
        'max_connections=200',
      ]);
    });

    it('should always set TEST_AGENT_URL in db-proxy env vars', () => {
      const item = makeDbItem();
      const dbConfig = makeDbConfig();

      const deployment = databaseBuilder.buildDatabaseDeployment(
        item,
        'test-namespace',
        'instance-1',
        'item-1',
        dbConfig,
      );

      const dbProxyEnv = deployment.spec!.template.spec!.containers[1].env!;
      const testAgentEnv = dbProxyEnv.find((e) => e.name === 'TEST_AGENT_URL');
      expect(testAgentEnv).toBeDefined();
      expect(testAgentEnv?.value).toContain('test-agent-service');
    });

    it('should use custom db credentials from item', () => {
      const item = makeDbItem({
        dbName: 'mydb',
        dbUser: 'myuser',
        dbPassword: 'mypass',
      });
      const dbConfig = makeDbConfig();

      const deployment = databaseBuilder.buildDatabaseDeployment(
        item,
        'test-namespace',
        'instance-1',
        'item-1',
        dbConfig,
      );

      const dbProxyEnv = deployment.spec!.template.spec!.containers[1].env!;
      const dbNameEnv = dbProxyEnv.find((e) => e.name === 'DB_NAME');
      const dbUserEnv = dbProxyEnv.find((e) => e.name === 'DB_USER');
      const dbPasswordEnv = dbProxyEnv.find((e) => e.name === 'DB_PASSWORD');
      expect(dbNameEnv?.value).toBe('mydb');
      expect(dbUserEnv?.value).toBe('myuser');
      expect(dbPasswordEnv?.value).toBe('mypass');
    });

    it('should fall back to default db credentials when item has none', () => {
      const item = makeDbItem();
      const dbConfig = makeDbConfig();

      const deployment = databaseBuilder.buildDatabaseDeployment(
        item,
        'test-namespace',
        'instance-1',
        'item-1',
        dbConfig,
      );

      const dbProxyEnv = deployment.spec!.template.spec!.containers[1].env!;
      const dbNameEnv = dbProxyEnv.find((e) => e.name === 'DB_NAME');
      const dbUserEnv = dbProxyEnv.find((e) => e.name === 'DB_USER');
      const dbPasswordEnv = dbProxyEnv.find((e) => e.name === 'DB_PASSWORD');
      // Should have values from config defaults (not undefined)
      expect(dbNameEnv).toBeDefined();
      expect(dbNameEnv?.value).toBeTruthy();
      expect(dbUserEnv).toBeDefined();
      expect(dbUserEnv?.value).toBeTruthy();
      expect(dbPasswordEnv).toBeDefined();
      expect(dbPasswordEnv?.value).toBeTruthy();
    });

    it('should select correct db-proxy image for postgresql alias', () => {
      const item = makeDbItem({ database: 'postgresql', k8sName: 'pg-db' });
      const dbConfig = makeDbConfig({ ports: [5432] });

      const deployment = databaseBuilder.buildDatabaseDeployment(
        item,
        'test-namespace',
        'instance-1',
        'item-1',
        dbConfig,
      );

      expect(deployment.spec!.template.spec!.containers[1].image).toBe(
        DOKKIMI_IMAGES.dbProxyPostgres,
      );
      expect(deployment.spec!.template.spec!.containers[1].ports).toEqual([
        { containerPort: 15432, name: 'query' },
      ]);
    });

    it('should mount init files for MongoDB even when initFiles is null', () => {
      const item = makeDbItem({
        database: 'mongodb',
        k8sName: 'mongo-db',
        initFiles: null,
      });
      const dbConfig = makeDbConfig({
        image: 'mongo:7',
        environment: {},
        ports: [27017],
      });

      const deployment = databaseBuilder.buildDatabaseDeployment(
        item,
        'test-namespace',
        'instance-1',
        'item-1',
        dbConfig,
      );

      const container = deployment.spec!.template.spec!.containers[0];
      const initMount = container.volumeMounts?.find(
        (vm) => vm.name === 'init-files',
      );
      expect(initMount).toBeDefined();
      expect(initMount?.mountPath).toBe('/docker-entrypoint-initdb.d');

      const initContainers = deployment.spec!.template.spec!.initContainers!;
      expect(initContainers).toHaveLength(1);
      expect(initContainers[0].name).toBe('fetch-init-files');
    });

    it('should not include command when dbConfig has none', () => {
      const item = makeDbItem();
      const dbConfig = makeDbConfig();

      const deployment = databaseBuilder.buildDatabaseDeployment(
        item,
        'test-namespace',
        'instance-1',
        'item-1',
        dbConfig,
      );

      expect(
        deployment.spec!.template.spec!.containers[0].command,
      ).toBeUndefined();
    });

    it('should handle dbConfig without volumeMounts and volumes', () => {
      const item = makeDbItem();
      const dbConfig = makeDbConfig();
      delete (dbConfig as any).volumeMounts;
      delete (dbConfig as any).volumes;

      const deployment = databaseBuilder.buildDatabaseDeployment(
        item,
        'test-namespace',
        'instance-1',
        'item-1',
        dbConfig,
      );

      // Should still produce a valid deployment with the standard volumes
      const containers = deployment.spec!.template.spec!.containers;
      expect(containers).toHaveLength(3);

      const volumes = deployment.spec!.template.spec!.volumes!;
      // Should contain the 3 standard volumes (varlog, docker-containers, fluent-bit-config)
      expect(volumes.find((v) => v.name === 'varlog')).toBeDefined();
      expect(volumes.find((v) => v.name === 'docker-containers')).toBeDefined();
      expect(volumes.find((v) => v.name === 'fluent-bit-config')).toBeDefined();
    });

    it('should set correct labels on pod template', () => {
      const item = makeDbItem();
      const dbConfig = makeDbConfig();

      const deployment = databaseBuilder.buildDatabaseDeployment(
        item,
        'test-namespace',
        'instance-1',
        'item-1',
        dbConfig,
      );

      const templateLabels = deployment.spec!.template.metadata!.labels!;
      expect(templateLabels['app']).toBe('postgres-db');
      expect(templateLabels['dokkimi.io/instance-id']).toBe('instance-1');
    });

    it('should set correct deployment metadata including namespace', () => {
      const item = makeDbItem();
      const dbConfig = makeDbConfig();

      const deployment = databaseBuilder.buildDatabaseDeployment(
        item,
        'my-namespace',
        'instance-1',
        'item-1',
        dbConfig,
      );

      expect(deployment.metadata!.namespace).toBe('my-namespace');
      expect(deployment.metadata!.labels).toEqual({ app: 'postgres-db' });
      expect(deployment.spec!.replicas).toBe(1);
      expect(deployment.spec!.selector).toEqual({
        matchLabels: { app: 'postgres-db' },
      });
    });

    it('should set terminationGracePeriodSeconds to 3', () => {
      const item = makeDbItem();
      const dbConfig = makeDbConfig();

      const deployment = databaseBuilder.buildDatabaseDeployment(
        item,
        'test-namespace',
        'instance-1',
        'item-1',
        dbConfig,
      );

      expect(
        deployment.spec!.template.spec!.terminationGracePeriodSeconds,
      ).toBe(3);
    });

    it('should not include initContainers when no init files needed', () => {
      const item = makeDbItem({ initFiles: null });
      const dbConfig = makeDbConfig();

      const deployment = databaseBuilder.buildDatabaseDeployment(
        item,
        'test-namespace',
        'instance-1',
        'item-1',
        dbConfig,
      );

      expect(deployment.spec!.template.spec!.initContainers).toBeUndefined();
    });

    it('should use MariaDB proxy port 13306 in db-proxy container', () => {
      const item = makeDbItem({ database: 'mariadb', k8sName: 'maria-db' });
      const dbConfig = makeDbConfig({
        image: 'mariadb:11',
        ports: [3306],
      });

      const deployment = databaseBuilder.buildDatabaseDeployment(
        item,
        'test-namespace',
        'instance-1',
        'item-1',
        dbConfig,
      );

      const dbProxy = deployment.spec!.template.spec!.containers[1];
      expect(dbProxy.ports).toEqual([{ containerPort: 13306, name: 'query' }]);
    });
  });

  // ─── buildDatabaseService ─────────────────────────────────────────

  describe('buildDatabaseService', () => {
    it('should route postgres through wire protocol proxy', () => {
      const item = makeDbItem();

      const k8sService = databaseBuilder.buildDatabaseService(
        item,
        'test-namespace',
        [5432],
      );

      expect(k8sService.metadata!.name).toBe('postgres-db');
      expect(k8sService.spec!.ports).toEqual([
        { port: 5432, targetPort: 15432, name: 'query' },
      ]);
    });

    it('should route mysql through wire protocol proxy', () => {
      const item = makeDbItem({ database: 'mysql', k8sName: 'mysql-db' });

      const k8sService = databaseBuilder.buildDatabaseService(
        item,
        'test-namespace',
        [3306],
      );

      expect(k8sService.spec!.ports).toEqual([
        { port: 3306, targetPort: 13306, name: 'query' },
      ]);
    });

    it('should route redis through wire protocol proxy', () => {
      const item = makeDbItem({ database: 'redis', k8sName: 'redis-db' });

      const k8sService = databaseBuilder.buildDatabaseService(
        item,
        'test-namespace',
        [6379],
      );

      expect(k8sService.spec!.ports).toEqual([
        { port: 6379, targetPort: 16379, name: 'query' },
      ]);
    });

    it('should expose wire protocol proxy port for MongoDB', () => {
      const item = makeDbItem({ database: 'mongodb', k8sName: 'mongo-db' });

      const k8sService = databaseBuilder.buildDatabaseService(
        item,
        'test-namespace',
        [27017],
      );

      expect(k8sService.spec!.ports).toEqual([
        { port: 27017, targetPort: 17017, name: 'query' },
      ]);
    });

    it('should route postgresql alias through wire protocol proxy', () => {
      const item = makeDbItem({
        database: 'postgresql',
        k8sName: 'pg-db',
      });

      const k8sService = databaseBuilder.buildDatabaseService(
        item,
        'test-namespace',
        [5432],
      );

      expect(k8sService.spec!.ports).toEqual([
        { port: 5432, targetPort: 15432, name: 'query' },
      ]);
    });

    it('should route mariadb through wire protocol proxy', () => {
      const item = makeDbItem({
        database: 'mariadb',
        k8sName: 'maria-db',
      });

      const k8sService = databaseBuilder.buildDatabaseService(
        item,
        'test-namespace',
        [3306],
      );

      expect(k8sService.spec!.ports).toEqual([
        { port: 3306, targetPort: 13306, name: 'query' },
      ]);
    });

    it('should set correct service metadata including namespace', () => {
      const item = makeDbItem();

      const k8sService = databaseBuilder.buildDatabaseService(
        item,
        'my-namespace',
        [5432],
      );

      expect(k8sService.metadata!.name).toBe('postgres-db');
      expect(k8sService.metadata!.namespace).toBe('my-namespace');
      expect(k8sService.spec!.selector).toEqual({ app: 'postgres-db' });
    });
  });
});
