import { DokkimiConfig, buildServiceUrl } from './config.types';
import {
  InterceptorEnvVars,
  TestAgentEnvVars,
  DbProxyEnvVars,
} from './go-service-env.types';

/**
 * Converts env vars object to K8s env array format
 * Filters out undefined optional values
 */
function toK8sEnvArray<T extends Record<string, string | undefined>>(
  envVars: T,
): Array<{ name: string; value: string }> {
  return Object.entries(envVars)
    .filter(([_, value]) => value !== undefined)
    .map(([name, value]) => ({ name, value: value! }));
}

export interface InterceptorConfig {
  namespace: string;
  k8sNamespace: string;
  apiKey: string;
  k8sDnsIP: string; // Dynamically discovered kube-dns ClusterIP
  namespaceItemId?: string;
  instanceItemName?: string;
  origin?: string;
  originDomain?: string;
  healthCheckEndpoint?: string;
  servicePort?: string;
  testAgentUrl?: string;
}

/**
 * Build type-safe environment variables for Interceptor service
 * TypeScript will error at compile-time if required fields are missing
 */
export function buildInterceptorEnvVars(
  config: DokkimiConfig,
  runtimeConfig: InterceptorConfig,
): Array<{ name: string; value: string }> {
  // Runtime validation for critical fields
  if (!runtimeConfig.apiKey) {
    throw new Error('apiKey is required for Interceptor');
  }
  if (!runtimeConfig.namespace) {
    throw new Error('namespace is required for Interceptor');
  }
  if (!runtimeConfig.k8sNamespace) {
    throw new Error('k8sNamespace is required for Interceptor');
  }
  if (!runtimeConfig.k8sDnsIP) {
    throw new Error('k8sDnsIP is required for Interceptor');
  }

  // TypeScript enforces all required fields are present!
  const envVars: InterceptorEnvVars = {
    PORT: config.services.interceptor.port.toString(),
    CONTROL_TOWER_URL: buildServiceUrl(config.services.controlTower, true),
    K8S_NAMESPACE: runtimeConfig.k8sNamespace,
    NAMESPACE: runtimeConfig.namespace,
    API_KEY: runtimeConfig.apiKey,
    K8S_DNS_IP: runtimeConfig.k8sDnsIP, // Dynamically discovered kube-dns ClusterIP
    // Optional fields
    ORIGIN: runtimeConfig.origin,
    ORIGIN_DOMAIN: runtimeConfig.originDomain,
    LOG_ACTIONS: config.logging.actions ? 'true' : 'false',
    HEALTH_CHECK_ENDPOINT: runtimeConfig.healthCheckEndpoint,
    SERVICE_PORT: runtimeConfig.servicePort,
    NAMESPACE_ITEM_ID: runtimeConfig.namespaceItemId,
    INSTANCE_ITEM_NAME: runtimeConfig.instanceItemName,
    TEST_AGENT_URL: runtimeConfig.testAgentUrl,
  };

  return toK8sEnvArray(envVars);
}

export interface TestAgentConfig {
  k8sNamespace: string;
  /**
   * CDP endpoint for the co-located chromium sidecar. Only set when the run's
   * definition has UI steps and Control Tower has attached a chromium container
   * to the test-agent pod. Undefined for API/DB-only runs.
   */
  browserURL?: string;
  defaultViewportWidth?: number;
  defaultViewportHeight?: number;
}

export function buildTestAgentEnvVars(
  config: DokkimiConfig,
  runtimeConfig: TestAgentConfig,
): Array<{ name: string; value: string }> {
  // Runtime validation for critical fields
  if (!runtimeConfig.k8sNamespace) {
    throw new Error('k8sNamespace is required for TestAgent');
  }

  const envVars: TestAgentEnvVars = {
    PORT: config.services.testAgent.port.toString(),
    K8S_NAMESPACE: runtimeConfig.k8sNamespace,
    CONTROL_TOWER_URL: buildServiceUrl(config.services.controlTower, true),
    CONFIG_MAP_NAME: 'dokkimi-interceptor-config',
    INTERCEPTOR_URL: `http://interceptor-service.${runtimeConfig.k8sNamespace}.svc.cluster.local:${config.services.interceptor.port}`,
    BROWSER_URL: runtimeConfig.browserURL,
    DEFAULT_VIEWPORT_WIDTH: runtimeConfig.defaultViewportWidth?.toString(),
    DEFAULT_VIEWPORT_HEIGHT: runtimeConfig.defaultViewportHeight?.toString(),
  };

  return toK8sEnvArray(envVars);
}

export interface DbProxyConfig {
  databaseType: string;
  databasePort: string;
  instanceItemName: string;
  namespace: string;
  namespaceItemId?: string;
  testAgentUrl?: string;
  dbUser?: string;
  dbPassword?: string;
  dbName?: string;
}

export function buildDbProxyEnvVars(
  config: DokkimiConfig,
  runtimeConfig: DbProxyConfig,
): Array<{ name: string; value: string }> {
  // Runtime validation for critical fields
  if (!runtimeConfig.databaseType) {
    throw new Error('databaseType is required for DbProxy');
  }
  if (!runtimeConfig.databasePort) {
    throw new Error('databasePort is required for DbProxy');
  }
  if (!runtimeConfig.instanceItemName) {
    throw new Error('instanceItemName is required for DbProxy');
  }
  if (!runtimeConfig.namespace) {
    throw new Error('namespace is required for DbProxy');
  }

  const dbType = runtimeConfig.databaseType.toLowerCase();
  const isPostgres = dbType === 'postgres' || dbType === 'postgresql';
  const isMysql = dbType === 'mysql' || dbType === 'mariadb';
  const isRedis = dbType === 'redis';
  const isMongo = dbType === 'mongodb';

  let queryPort = '8080';
  if (isPostgres) {
    queryPort = '15432';
  } else if (isMysql) {
    queryPort = '13306';
  } else if (isRedis) {
    queryPort = '16379';
  } else if (isMongo) {
    queryPort = '17017';
  }

  const envVars: DbProxyEnvVars = {
    DATABASE_TYPE: runtimeConfig.databaseType,
    DATABASE_PORT: runtimeConfig.databasePort,
    INSTANCE_ITEM_NAME: runtimeConfig.instanceItemName,
    NAMESPACE: runtimeConfig.namespace,
    CONTROL_TOWER_URL: buildServiceUrl(config.services.controlTower, true),
    NAMESPACE_ITEM_ID: runtimeConfig.namespaceItemId,
    TEST_AGENT_URL: runtimeConfig.testAgentUrl,
    QUERY_PORT: queryPort,
    DB_USER: runtimeConfig.dbUser,
    DB_PASSWORD: runtimeConfig.dbPassword,
    DB_NAME: runtimeConfig.dbName,
  };

  return toK8sEnvArray(envVars);
}
