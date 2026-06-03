import { DockerDatabaseGroupService } from './docker-database-group.service';
import { DefinitionItem } from '../deployment-context.types';

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
}));

jest.mock('dockerode', () => jest.fn(() => ({})));

jest.mock('@dokkimi/config', () => ({
  getConfig: () => ({
    services: {
      controlTower: {
        port: 19001,
        host: 'host.docker.internal',
        protocol: 'http',
      },
      testAgent: { port: 80 },
    },
    database: {
      defaultName: 'dokkimi',
      defaultUser: 'dokkimi',
      defaultPassword: 'dokkimi',
    },
    logging: { actions: false },
  }),
  buildDbProxyEnvVars: jest.fn().mockReturnValue([
    { name: 'DATABASE_TYPE', value: 'postgres' },
    { name: 'DATABASE_PORT', value: '55432' },
    { name: 'CONTROL_TOWER_URL', value: 'http://host.docker.internal:19001' },
  ]),
  buildServiceUrl: jest
    .fn()
    .mockReturnValue('http://host.docker.internal:19001'),
}));

const mockDockerClient = {
  runContainer: jest.fn().mockResolvedValue('container-id'),
};

const mockDatabaseConfig = {
  getConfig: jest.fn(),
};

const mockRunStorage = {
  getInitFilesDir: jest.fn().mockReturnValue('/home/.dokkimi/storage/init'),
};

function pgConfig() {
  return {
    image: 'postgres:15',
    environment: {
      POSTGRES_DB: 'dokkimi',
      POSTGRES_USER: 'dokkimi',
      POSTGRES_PASSWORD: 'dokkimi',
    },
    ports: [5432],
  };
}

function mysqlConfig() {
  return {
    image: 'mysql:8',
    environment: {
      MYSQL_DATABASE: 'dokkimi',
      MYSQL_USER: 'dokkimi',
      MYSQL_PASSWORD: 'dokkimi',
      MYSQL_ROOT_PASSWORD: 'dokkimi',
    },
    ports: [3306],
  };
}

function redisConfig() {
  return {
    image: 'redis:7',
    environment: {},
    ports: [6379],
  };
}

function mongoConfig() {
  return {
    image: 'mongo:7',
    environment: {
      MONGO_INITDB_ROOT_USERNAME: 'dokkimi',
      MONGO_INITDB_ROOT_PASSWORD: 'dokkimi',
    },
    ports: [27017],
  };
}

function buildDbItem(
  overrides: Partial<DefinitionItem> = {},
): DefinitionItem {
  return {
    name: 'postgres-db',
    type: 'DATABASE',
    database: 'postgres',
    ...overrides,
  };
}

let service: DockerDatabaseGroupService;

beforeEach(() => {
  jest.clearAllMocks();
  mockDatabaseConfig.getConfig.mockReturnValue(pgConfig());
  service = new DockerDatabaseGroupService(
    mockDockerClient as any,
    mockDatabaseConfig as any,
    mockRunStorage as any,
  );
});

describe('DockerDatabaseGroupService', () => {
  describe('createDatabaseGroup — container topology', () => {
    it('should create 2 containers: db-proxy then database', async () => {
      await service.createDatabaseGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildDbItem(),
        'postgres-db',
        'item-1',
      );

      expect(mockDockerClient.runContainer).toHaveBeenCalledTimes(2);
    });

    it('should create db-proxy first, then database', async () => {
      const callOrder: string[] = [];
      mockDockerClient.runContainer.mockImplementation(async (opts: any) => {
        callOrder.push(opts.name);
        return 'container-id';
      });

      await service.createDatabaseGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildDbItem(),
        'postgres-db',
        'item-1',
      );

      expect(callOrder[0]).toBe('postgres-db-dbproxy-inst1');
      expect(callOrder[1]).toBe('postgres-db-db-inst1');
    });

    it('should give db-proxy the network alias', async () => {
      await service.createDatabaseGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildDbItem(),
        'postgres-db',
        'item-1',
      );

      const proxyCall = mockDockerClient.runContainer.mock.calls[0][0];
      expect(proxyCall.networkAliases).toEqual(['postgres-db']);
    });

    it('should join database to db-proxy network namespace', async () => {
      await service.createDatabaseGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildDbItem(),
        'postgres-db',
        'item-1',
      );

      const dbCall = mockDockerClient.runContainer.mock.calls[1][0];
      expect(dbCall.networkMode).toBe('container:postgres-db-dbproxy-inst1');
    });

    it('should set correct labels on both containers', async () => {
      await service.createDatabaseGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildDbItem(),
        'postgres-db',
        'item-1',
      );

      const proxyCall = mockDockerClient.runContainer.mock.calls[0][0];
      expect(proxyCall.labels['io.dokkimi.role']).toBe('db-proxy');
      expect(proxyCall.labels['io.dokkimi.instance-id']).toBe('inst1');
      expect(proxyCall.labels['io.dokkimi.item-name']).toBe('postgres-db');

      const dbCall = mockDockerClient.runContainer.mock.calls[1][0];
      expect(dbCall.labels['io.dokkimi.role']).toBe('database');
    });

    it('should skip if item has no database type', async () => {
      await service.createDatabaseGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildDbItem({ database: null }),
        'postgres-db',
        'item-1',
      );

      expect(mockDockerClient.runContainer).not.toHaveBeenCalled();
    });
  });

  describe('port shifting', () => {
    it('should shift postgres to internal port 55432', async () => {
      await service.createDatabaseGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildDbItem({ database: 'postgres' }),
        'postgres-db',
        'item-1',
      );

      const proxyCall = mockDockerClient.runContainer.mock.calls[0][0];
      expect(proxyCall.exposedPorts).toContain(5432);
      expect(proxyCall.exposedPorts).toContain(55432);

      const dbCall = mockDockerClient.runContainer.mock.calls[1][0];
      expect(dbCall.env.PGPORT).toBe('55432');
    });

    it('should shift mysql to internal port 33306', async () => {
      mockDatabaseConfig.getConfig.mockReturnValue(mysqlConfig());

      await service.createDatabaseGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildDbItem({ database: 'mysql' }),
        'mysql-db',
        'item-1',
      );

      const dbCall = mockDockerClient.runContainer.mock.calls[1][0];
      expect(dbCall.env.MYSQL_TCP_PORT).toBe('33306');
    });

    it('should shift redis via command arg', async () => {
      mockDatabaseConfig.getConfig.mockReturnValue(redisConfig());

      await service.createDatabaseGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildDbItem({ database: 'redis' }),
        'redis-cache',
        'item-1',
      );

      const dbCall = mockDockerClient.runContainer.mock.calls[1][0];
      expect(dbCall.cmd).toContain('--port');
      expect(dbCall.cmd).toContain('63790');
    });

    it('should set QUERY_PORT on db-proxy to the native port', async () => {
      await service.createDatabaseGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildDbItem({ database: 'postgres' }),
        'postgres-db',
        'item-1',
      );

      const proxyCall = mockDockerClient.runContainer.mock.calls[0][0];
      expect(proxyCall.env.QUERY_PORT).toBe('5432');
    });
  });

  describe('MongoDB entrypoint', () => {
    beforeEach(() => {
      mockDatabaseConfig.getConfig.mockReturnValue(mongoConfig());
    });

    it('should use custom entrypoint for MongoDB', async () => {
      await service.createDatabaseGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildDbItem({ database: 'mongodb' }),
        'mongo-db',
        'item-1',
      );

      const dbCall = mockDockerClient.runContainer.mock.calls[1][0];
      expect(dbCall.entrypoint).toEqual([
        '/bin/bash',
        '-c',
        expect.any(String),
      ]);
    });

    it('should use process.env for credentials (no shell injection)', async () => {
      await service.createDatabaseGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildDbItem({ database: 'mongodb' }),
        'mongo-db',
        'item-1',
      );

      const dbCall = mockDockerClient.runContainer.mock.calls[1][0];
      const entrypoint = dbCall.entrypoint[2];
      expect(entrypoint).toContain('process.env.MONGO_INITDB_ROOT_USERNAME');
      expect(entrypoint).toContain('process.env.MONGO_INITDB_ROOT_PASSWORD');
      expect(entrypoint).not.toContain("user:'dokkimi'");
    });

    it('should use internal port 27018 in entrypoint', async () => {
      await service.createDatabaseGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildDbItem({ database: 'mongodb' }),
        'mongo-db',
        'item-1',
      );

      const dbCall = mockDockerClient.runContainer.mock.calls[1][0];
      const entrypoint = dbCall.entrypoint[2];
      expect(entrypoint).toContain('--port 27018');
    });

    it('should include --auth flag when credentials are set', async () => {
      await service.createDatabaseGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildDbItem({ database: 'mongodb' }),
        'mongo-db',
        'item-1',
      );

      const dbCall = mockDockerClient.runContainer.mock.calls[1][0];
      const entrypoint = dbCall.entrypoint[2];
      expect(entrypoint).toContain('--auth');
    });

    it('should not include --auth when no credentials', async () => {
      mockDatabaseConfig.getConfig.mockReturnValue({
        ...mongoConfig(),
        environment: {},
      });

      await service.createDatabaseGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildDbItem({ database: 'mongodb' }),
        'mongo-db',
        'item-1',
      );

      const dbCall = mockDockerClient.runContainer.mock.calls[1][0];
      const entrypoint = dbCall.entrypoint[2];
      expect(entrypoint).not.toContain('--auth');
      expect(entrypoint).not.toContain('createUser');
    });
  });

  describe('init files', () => {
    it('should mount init files directory when present', async () => {
      await service.createDatabaseGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildDbItem({
          initFiles: [{ filename: 'schema.sql', content: Buffer.from('') }],
        }),
        'postgres-db',
        'item-1',
      );

      const dbCall = mockDockerClient.runContainer.mock.calls[1][0];
      expect(dbCall.binds).toContain(
        '/home/.dokkimi/storage/init:/docker-entrypoint-initdb.d:ro',
      );
    });

    it('should not mount init files for redis', async () => {
      mockDatabaseConfig.getConfig.mockReturnValue(redisConfig());

      await service.createDatabaseGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildDbItem({
          database: 'redis',
          initFiles: [{ filename: 'data.rdb', content: Buffer.from('') }],
        }),
        'redis-cache',
        'item-1',
      );

      const dbCall = mockDockerClient.runContainer.mock.calls[1][0];
      expect(dbCall.binds).toEqual([]);
    });

    it('should always mount init dir for mongodb (for custom entrypoint)', async () => {
      mockDatabaseConfig.getConfig.mockReturnValue(mongoConfig());

      await service.createDatabaseGroup(
        'dokkimi-run-inst1',
        'inst1',
        buildDbItem({ database: 'mongodb' }),
        'mongo-db',
        'item-1',
      );

      const dbCall = mockDockerClient.runContainer.mock.calls[1][0];
      expect(dbCall.binds).toContain(
        '/home/.dokkimi/storage/init:/docker-entrypoint-initdb.d:ro',
      );
    });
  });

  describe('getDbProxyImage', () => {
    it('should return correct image for each database type', () => {
      expect(service.getDbProxyImage('postgres')).toContain('db-proxy-postgres');
      expect(service.getDbProxyImage('postgresql')).toContain(
        'db-proxy-postgres',
      );
      expect(service.getDbProxyImage('mysql')).toContain('db-proxy-mysql');
      expect(service.getDbProxyImage('mariadb')).toContain('db-proxy-mysql');
      expect(service.getDbProxyImage('mongodb')).toContain('db-proxy-mongo');
      expect(service.getDbProxyImage('redis')).toContain('db-proxy-redis');
    });

    it('should throw for unsupported database type', () => {
      expect(() => service.getDbProxyImage('sqlite')).toThrow(
        'Unsupported database type',
      );
    });

    it('should be case-insensitive', () => {
      expect(service.getDbProxyImage('PostgreSQL')).toContain(
        'db-proxy-postgres',
      );
      expect(service.getDbProxyImage('MYSQL')).toContain('db-proxy-mysql');
    });
  });
});
