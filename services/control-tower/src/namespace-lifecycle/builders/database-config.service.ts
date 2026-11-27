import { Injectable } from '@nestjs/common';
import { getConfig } from '@dokkimi/config';

export interface DatabaseConfig {
  image: string;
  environment: Record<string, string>;
  ports: number[];
  command?: string[];
}

export interface DatabaseCredentials {
  dbName?: string | null;
  dbUser?: string | null;
  dbPassword?: string | null;
  noAuth?: boolean | null;
}

export interface ResolvedCredentials {
  dbName: string;
  dbUser: string;
  dbPassword: string;
}

/**
 * With noAuth, the user and database each engine has without credentials.
 * Before, they were empty, and clients connecting as "" (Dokkimi's health
 * checks, dbQuery) were refused, so the database never became ready.
 */
const NO_AUTH: Record<string, { dbUser: string; dbName: string }> = {
  postgres: { dbUser: 'postgres', dbName: 'postgres' },
  mysql: { dbUser: 'root', dbName: '' },
};

export function resolveDbCredentials(
  creds: DatabaseCredentials | undefined,
  databaseType?: string,
): ResolvedCredentials {
  const config = getConfig();
  if (creds?.noAuth === true) {
    const engine = NO_AUTH[databaseType?.toLowerCase() ?? ''];
    return {
      dbName: engine?.dbName ?? '',
      dbUser: engine?.dbUser ?? '',
      dbPassword: '',
    };
  }
  return {
    dbName: creds?.dbName ?? config.database.defaultName,
    dbUser: creds?.dbUser ?? config.database.defaultUser,
    dbPassword: creds?.dbPassword ?? config.database.defaultPassword,
  };
}

@Injectable()
export class DatabaseConfigService {
  getConfig(
    databaseType: string,
    credentials?: DatabaseCredentials,
    version?: string,
  ): DatabaseConfig {
    const config = getConfig();

    const { dbName, dbUser, dbPassword } = resolveDbCredentials(
      credentials,
      databaseType,
    );
    const noAuth = credentials?.noAuth === true;
    const imgs = config.images.databases;

    const configs: Record<string, DatabaseConfig> = {
      postgres: {
        image: version ? `postgres:${version}` : imgs.postgres,
        environment: {
          POSTGRES_DB: dbName,
          POSTGRES_USER: dbUser,
          POSTGRES_PASSWORD: dbPassword,
          ...(noAuth ? { POSTGRES_HOST_AUTH_METHOD: 'trust' } : {}),
        },
        ports: [5432],
      },
      mysql: {
        image: version ? `mysql:${version}` : imgs.mysql,
        environment: {
          MYSQL_DATABASE: dbName,
          // The image refuses MYSQL_USER=root: root is set up by
          // MYSQL_ROOT_PASSWORD, and the container exited
          ...(dbUser === 'root'
            ? {}
            : { MYSQL_USER: dbUser, MYSQL_PASSWORD: dbPassword }),
          MYSQL_ROOT_PASSWORD: dbPassword,
          ...(noAuth ? { MYSQL_ALLOW_EMPTY_PASSWORD: 'yes' } : {}),
        },
        ports: [3306],
        command: [
          'mysqld',
          '--innodb-buffer-pool-size=64M',
          '--innodb-log-file-size=16M',
          '--innodb-flush-log-at-trx-commit=0',
          '--innodb-flush-method=nosync',
          '--skip-innodb-doublewrite',
          '--performance-schema=OFF',
        ],
      },
      mongodb: {
        image: version ? `mongo:${version}` : imgs.mongodb,
        environment: {
          MONGO_INITDB_DATABASE: dbName,
          ...(dbUser && dbPassword
            ? {
                MONGO_INITDB_ROOT_USERNAME: dbUser,
                MONGO_INITDB_ROOT_PASSWORD: dbPassword,
              }
            : {}),
        },
        ports: [27017],
      },
      redis: {
        image: version ? `redis:${version}` : imgs.redis,
        environment: {
          ...(dbPassword ? { REDIS_PASSWORD: dbPassword } : {}),
        },
        ports: [6379],
        ...(dbPassword
          ? { command: ['redis-server', '--requirepass', dbPassword] }
          : {}),
      },
    };

    return (
      configs[databaseType.toLowerCase()] || {
        image: `${databaseType}:${version || 'latest'}`,
        environment: {},
        ports: [],
      }
    );
  }
}
