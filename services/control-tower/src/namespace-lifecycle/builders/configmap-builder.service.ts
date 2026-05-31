import { Injectable } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { getConfig, buildServiceUrl } from '@dokkimi/config';
import { ItemDefinitionLike } from './deployment-builder.types';

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

@Injectable()
export class ConfigMapBuilderService {
  /**
   * Builds a ConfigMap containing interceptor configuration (urlMap and httpMocks)
   */
  buildInterceptorConfigMap(
    namespace: string,
    items: ItemDefinitionLike[],
    mocks: MockEndpoint[] = [],
    instanceId?: string,
    testConfig?: {
      testRunId: string;
      callbackUrl?: string;
      timeoutSeconds: number;
      executionMode: string;
      tests: any[];
      variables?: Record<string, string>;
    },
    expectedNamespaceItemIds?: string[],
  ): k8s.V1ConfigMap {
    // Build URL map from config items
    const urlMap: UrlMap = {};
    const databaseMap: DatabaseMap = {};

    // Build pod name to instanceItemId mapping
    // Pod names follow pattern: <k8sName>-<hash>-<hash>
    // We map by deployment name (k8sName) prefix to instanceItemId
    const podNameToNamespaceItemId: Record<string, string> = {};

    for (const item of items) {
      // Add to pod name mapping (for both services and databases)
      // Use item.id which should be the instanceItemId
      if (item.k8sName && item.id) {
        podNameToNamespaceItemId[item.k8sName] = item.id;
      }

      if (item.type === 'SERVICE' && item.k8sName && item.port) {
        // Use k8sName as the key (this is the Kubernetes service name)
        // The value maps to the service information
        // All services expose port 80 (standardized) - no need to specify port in URL
        urlMap[item.k8sName] = {
          scheme: 'http',
          url: `http://${item.k8sName}`,
          name: item.name, // User-friendly name
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
      } else if (item.type === 'DATABASE' && item.k8sName && item.id) {
        // Build database map entry
        // Extract database type from item (should have a database field)
        const dbType = item.database || 'postgres';
        const normalizedDbType = this.normalizeDatabaseType(dbType);

        // Use credentials from item or fall back to config defaults (matching DatabaseConfigService)
        const config = getConfig();
        const dbName = item.dbName ?? config.database.defaultName;
        const dbUser = item.dbUser ?? config.database.defaultUser;
        const dbPassword = item.dbPassword ?? config.database.defaultPassword;

        databaseMap[item.k8sName] = {
          type: normalizedDbType,
          user: dbUser,
          password: dbPassword,
          database: dbName,
          port: this.getNativeDbPort(normalizedDbType),
          instanceItemId: item.id,
        };
      }
    }

    // Build Fluent Bit configuration for console log collection
    const fluentBitConfig = this.buildFluentBitConfig(instanceId);

    const data: Record<string, string> = {
      urlMap: JSON.stringify(urlMap, null, 2),
      httpMocks: JSON.stringify(mocks, null, 2),
      'fluent-bit.conf': fluentBitConfig,
      podNameToNamespaceItemId: JSON.stringify(
        podNameToNamespaceItemId,
        null,
        2,
      ),
    };

    // Add databaseMap if there are any databases
    if (Object.keys(databaseMap).length > 0) {
      data.databaseMap = JSON.stringify(databaseMap, null, 2);
    }

    // Add test configuration if provided
    if (testConfig) {
      data.testConfig = JSON.stringify(testConfig, null, 2);
    }

    // Add expected namespace item IDs if provided
    if (expectedNamespaceItemIds && expectedNamespaceItemIds.length > 0) {
      data.expectedNamespaceItemIds = JSON.stringify(
        expectedNamespaceItemIds,
        null,
        2,
      );
    }

    return {
      metadata: {
        name: 'dokkimi-interceptor-config',
        namespace,
        labels: {
          'app.kubernetes.io/name': 'dokkimi',
          'app.kubernetes.io/component': 'interceptor-config',
        },
      },
      data,
    };
  }

  /**
   * Builds Fluent Bit configuration for console log collection
   * Reads container stdout/stderr, parses log levels, and sends to LPS
   * Only reads logs from the pod where Fluent Bit is running (using POD_NAME env var)
   * Excludes logs from sidecar containers (fluent-bit, dnsmasq)
   */
  private buildFluentBitConfig(instanceId?: string): string {
    // Minimal Fluent Bit configuration - just forward raw log lines to CT.
    // CT's log-processing module handles parsing log levels from messages
    // like [INFO], [WARN], etc.
    // If instanceId is provided, inject it directly; otherwise use env var (for runtime expansion)
    const instanceIdValue = instanceId || '${INSTANCE_ID}';
    const config = getConfig();
    // Build CT URL for cluster access (uses host.docker.internal since CT runs outside cluster)
    const ctUrl = new URL(buildServiceUrl(config.services.controlTower, true));

    return `[SERVICE]
    Flush         1
    Grace         1
    Daemon        off
    Log_Level     info

[INPUT]
    Name              tail
    Path              /var/log/containers/\${POD_NAME}_*.log
    Exclude_Path      /var/log/containers/*_fluent-bit-*.log,/var/log/containers/*_dnsmasq-*.log,/var/log/containers/*_interceptor-*.log,/var/log/containers/*_db-proxy-*.log
    Tag               kube.*
    Read_from_Head    On
    Refresh_Interval  1
    Mem_Buf_Limit     50MB
    Skip_Long_Lines   On
    DB                /tmp/flb_kube.db
    DB.locking        true

[FILTER]
    Name                record_modifier
    Match               kube.*
    record              instanceId ${instanceIdValue}
    record              instanceItemId \${INSTANCE_ITEM_ID}

[OUTPUT]
    Name                http
    Match               *
    Host                ${ctUrl.hostname}
    URI                 /logs/console
    Port                ${ctUrl.port}
    Format              json
    header              Content-Type application/json
    tls                 Off
    tls.verify          Off
    Retry_Limit         3
`;
  }

  /**
   * Builds a ConfigMap containing database credentials
   * Keys use k8sName (sanitized service name), not user-friendly name
   * Fallback to config.database.default* happens here in Control Tower
   */
  buildDbCredentialsConfigMap(
    namespace: string,
    databases: Array<{
      name: string;
      k8sName: string; // IMPORTANT: Use k8sName as the key
      dbName?: string | null;
      dbUser?: string | null;
      dbPassword?: string | null;
    }>,
  ): k8s.V1ConfigMap {
    const config = getConfig(); // Control Tower has access to YAML config

    const credentials: Record<string, object> = {};
    for (const db of databases) {
      credentials[db.k8sName] = {
        dbName: db.dbName || config.database.defaultName,
        dbUser: db.dbUser || config.database.defaultUser,
        dbPassword: db.dbPassword || config.database.defaultPassword,
      };
    }

    return {
      metadata: {
        name: 'dokkimi-db-credentials',
        namespace,
        labels: {
          'app.kubernetes.io/name': 'dokkimi',
          'app.kubernetes.io/component': 'db-credentials',
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
