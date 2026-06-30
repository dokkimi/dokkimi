import { Injectable } from '@nestjs/common';
import { getConfig } from '@dokkimi/config';

export interface DatabaseConfig {
  image: string;
  environment: Record<string, string>;
  ports: number[];
  command?: string[];
}

export interface DatabaseCredentials {
  dbName?: string;
  dbUser?: string;
  dbPassword?: string;
  noAuth?: boolean;
}

@Injectable()
export class DatabaseConfigService {
  getConfig(
    databaseType: string,
    credentials?: DatabaseCredentials,
    version?: string,
  ): DatabaseConfig {
    const config = getConfig();

    // Use provided credentials or fall back to config defaults
    const noAuth = credentials?.noAuth === true;
    const dbName = noAuth
      ? ''
      : (credentials?.dbName ?? config.database.defaultName);
    const dbUser = noAuth
      ? ''
      : (credentials?.dbUser ?? config.database.defaultUser);
    const dbPassword = noAuth
      ? ''
      : (credentials?.dbPassword ?? config.database.defaultPassword);
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
          MYSQL_USER: dbUser,
          MYSQL_PASSWORD: dbPassword,
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
