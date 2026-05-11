import { Injectable } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { getConfig } from '@dokkimi/config';

export interface DatabaseConfig {
  image: string;
  environment: Record<string, string>;
  ports: number[];
  command?: string[];
  volumeMounts?: k8s.V1VolumeMount[];
  volumes?: k8s.V1Volume[];
}

export interface DatabaseCredentials {
  dbName?: string;
  dbUser?: string;
  dbPassword?: string;
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
    const dbName = credentials?.dbName || config.database.defaultName;
    const dbUser = credentials?.dbUser || config.database.defaultUser;
    const dbPassword =
      credentials?.dbPassword || config.database.defaultPassword;
    const configs: Record<string, DatabaseConfig> = {
      postgres: {
        image: `postgres:${version || '15'}`,
        environment: {
          POSTGRES_DB: dbName,
          POSTGRES_USER: dbUser,
          POSTGRES_PASSWORD: dbPassword,
        },
        ports: [5432],
        volumeMounts: [
          {
            name: 'postgres-data',
            mountPath: '/var/lib/postgresql/data',
          },
        ],
        volumes: [
          {
            name: 'postgres-data',
            emptyDir: {},
          },
        ],
      },
      mysql: {
        image: `mysql:${version || '8'}`,
        environment: {
          MYSQL_DATABASE: dbName,
          MYSQL_USER: dbUser,
          MYSQL_PASSWORD: dbPassword,
          MYSQL_ROOT_PASSWORD: dbPassword, // Same as password for simplicity
        },
        ports: [3306],
        volumeMounts: [
          {
            name: 'mysql-data',
            mountPath: '/var/lib/mysql',
          },
        ],
        volumes: [
          {
            name: 'mysql-data',
            emptyDir: {},
          },
        ],
      },
      mongodb: {
        image: `mongo:${version || '7'}`,
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
        volumeMounts: [
          {
            name: 'mongo-data',
            mountPath: '/data/db',
          },
        ],
        volumes: [
          {
            name: 'mongo-data',
            emptyDir: {},
          },
        ],
      },
      redis: {
        image: `redis:${version || '7-alpine'}`,
        environment: {
          ...(dbPassword ? { REDIS_PASSWORD: dbPassword } : {}),
        },
        ports: [6379],
        ...(dbPassword
          ? { command: ['redis-server', '--requirepass', dbPassword] }
          : {}),
        volumeMounts: [
          {
            name: 'redis-data',
            mountPath: '/data',
          },
        ],
        volumes: [
          {
            name: 'redis-data',
            emptyDir: {},
          },
        ],
      },
    };

    return (
      configs[databaseType.toLowerCase()] || {
        image: `${databaseType}:latest`,
        environment: {},
        ports: [],
      }
    );
  }
}
