import { Injectable } from '@nestjs/common';
import { resolveDbCredentials } from './database-config.service';

export interface ItemDefinitionLike {
  name: string;
  containerName: string;
  type: string;
  description?: string | null;
  image?: string | null;
  port?: number | null;
  healthCheck?: string | null;
  uiPath?: string | null;
  domain?: string | null;
  env?: any;
  minCpu?: number | null;
  minMemory?: number | null;
  maxCpu?: number | null;
  maxMemory?: number | null;
  localDevPath?: string | null;
  mountPath?: string | null;
  broker?: string | null;
  database?: string | null;
  initFiles?: { filename: string }[] | null;
  dbName?: string | null;
  dbUser?: string | null;
  dbPassword?: string | null;
  noAuth?: boolean | null;
  id?: string;
}

export interface MockEndpoint {
  method: string;
  origin: string;
  target: string;
  path: string;
  requestBodyContains?: string;
  requestBodyMatches?: string;
  delayMS?: number;
  responseStatus?: number;
  responseHeaders?: string;
  responseBody?: string;
}

export interface ServiceInfo {
  scheme: string;
  url: string;
  name: string;
  port?: number;
  instanceItemId?: string;
}

export type UrlMap = Record<string, ServiceInfo>;

export interface DatabaseInfo {
  type: string;
  user: string;
  password: string;
  database: string;
  port: number;
  instanceItemId: string;
}

export type DatabaseMap = Record<string, DatabaseInfo>;

export interface BrokerInfo {
  type: string;
  port: number;
  instanceItemId: string;
}

export type BrokerMap = Record<string, BrokerInfo>;

@Injectable()
export class ConfigMapBuilderService {
  /**
   * Builds a ConfigMap containing interceptor configuration (urlMap and httpMocks)
   */
  buildInterceptorConfigMap(
    namespace: string,
    items: ItemDefinitionLike[],
    mocks: MockEndpoint[] = [],
    _instanceId?: string,
    testConfig?: {
      testRunId: string;
      callbackUrl?: string;
      timeoutSeconds: number;
      executionMode: string;
      tests: any[];
      variables?: Record<string, unknown>;
    },
    expectedItemStages?: string[][],
  ): { metadata?: Record<string, unknown>; data?: Record<string, string> } {
    // Build URL map from config items
    const urlMap: UrlMap = {};
    const databaseMap: DatabaseMap = {};
    const brokerMap: BrokerMap = {};

    // Build container name to instanceItemId mapping
    const podNameToNamespaceItemId: Record<string, string> = {};

    for (const item of items) {
      // Add to pod name mapping (for both services and databases)
      // Use item.id which should be the instanceItemId
      if (item.containerName && item.id) {
        podNameToNamespaceItemId[item.containerName] = item.id;
      }

      if (item.type === 'SERVICE' && item.containerName && item.port) {
        // Use containerName as the key (this is the container/service name)
        // The value maps to the service information
        urlMap[item.containerName] = {
          scheme: 'http',
          url: `http://${item.containerName}`,
          name: item.name,
          port: item.port,
          instanceItemId: item.id,
        };

        // Also map domain if provided
        if (item.domain) {
          urlMap[item.domain] = {
            scheme: 'https',
            url: `https://${item.domain}`,
            name: item.name,
            instanceItemId: item.id,
          };
        }
      } else if (item.type === 'DATABASE' && item.containerName && item.id) {
        const dbType = item.database || 'postgres';
        const normalizedDbType = this.normalizeDatabaseType(dbType);

        const { dbName, dbUser, dbPassword } = resolveDbCredentials(item);

        databaseMap[item.containerName] = {
          type: normalizedDbType,
          user: dbUser,
          password: dbPassword,
          database: dbName,
          port: this.getNativeDbPort(normalizedDbType),
          instanceItemId: item.id,
        };
      } else if (item.type === 'BROKER' && item.containerName && item.id) {
        brokerMap[item.containerName] = {
          type: item.broker || 'amqp',
          port: this.getNativeBrokerPort(item.broker || 'amqp'),
          instanceItemId: item.id,
        };
      }
    }

    const data: Record<string, string> = {
      urlMap: JSON.stringify(urlMap, null, 2),
      httpMocks: JSON.stringify(mocks, null, 2),
      podNameToNamespaceItemId: JSON.stringify(
        podNameToNamespaceItemId,
        null,
        2,
      ),
    };

    if (Object.keys(databaseMap).length > 0) {
      data.databaseMap = JSON.stringify(databaseMap, null, 2);
    }

    if (Object.keys(brokerMap).length > 0) {
      data.brokerMap = JSON.stringify(brokerMap, null, 2);
    }

    // Add test configuration if provided
    if (testConfig) {
      data.testConfig = JSON.stringify(testConfig, null, 2);
    }

    // Add expected item stages if provided (staged health gating)
    if (expectedItemStages && expectedItemStages.length > 0) {
      data.expectedItemStages = JSON.stringify(expectedItemStages, null, 2);
    }

    return {
      metadata: {
        name: 'dokkimi-interceptor-config',
        namespace,
        labels: {
          'app.dokkimi.io/name': 'dokkimi',
          'app.dokkimi.io/component': 'interceptor-config',
        },
      },
      data,
    };
  }

  /**
   * Builds a ConfigMap containing database credentials
   * Keys use sanitized service name, not user-friendly name
   * Fallback to config.database.default* happens here in Control Tower
   */
  buildDbCredentialsConfigMap(
    namespace: string,
    databases: Array<{
      name: string;
      containerName: string; // IMPORTANT: Use containerName as the key
      dbName?: string | null;
      dbUser?: string | null;
      dbPassword?: string | null;
      noAuth?: boolean | null;
    }>,
  ): { metadata?: Record<string, unknown>; data?: Record<string, string> } {
    const credentials: Record<string, object> = {};
    for (const db of databases) {
      credentials[db.containerName] = resolveDbCredentials(db);
    }

    return {
      metadata: {
        name: 'dokkimi-db-credentials',
        namespace,
        labels: {
          'app.dokkimi.io/name': 'dokkimi',
          'app.dokkimi.io/component': 'db-credentials',
        },
      },
      data: {
        'credentials.json': JSON.stringify(credentials, null, 2),
      },
    };
  }

  /**
   * Normalizes database type to standard format
   */
  private normalizeDatabaseType(dbType: string): string {
    const normalized = dbType.toLowerCase();
    if (normalized === 'postgres') {
      return 'postgresql';
    }
    if (normalized === 'mariadb') {
      return 'mysql';
    }
    return normalized;
  }

  private getNativeBrokerPort(brokerType: string): number {
    switch (brokerType.toLowerCase()) {
      case 'amqp':
        return 5672;
      case 'kafka':
        return 9092;
      default:
        return 5672;
    }
  }

  private getNativeDbPort(normalizedDbType: string): number {
    switch (normalizedDbType) {
      case 'postgresql':
        return 5432;
      case 'mysql':
        return 3306;
      case 'redis':
        return 6379;
      case 'mongodb':
        return 27017;
      default:
        return 5432;
    }
  }
}
