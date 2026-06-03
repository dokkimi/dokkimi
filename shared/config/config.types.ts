export interface DokkimiConfig {
  services: {
    controlTower: ServiceConfig;
    interceptor: { port: number };
    testAgent: { port: number };
    chromium: { port: number };
  };

  clusterWatcher: {
    idlePollIntervalMs: number;
    activePollIntervalMs: number;
  };

  frontend?: {
    vite: ServiceConfig;
  };

  concurrency: {
    maxConcurrentTests: number;
    maxBootingTests: number;
  };

  network: {
    dns: {
      nameserver: string;
    };
    proxy: {
      noProxy: string;
    };
  };

  external: {
    helm: {
      installDocs: string;
    };
  };

  timeouts: {
    httpRequest: number;
    metricsInterval: number;
  };

  database: {
    defaultUser: string;
    defaultPassword: string;
    defaultName: string;
    url: string;
  };

  storage: {
    dir: string;
    initFilesDir: string;
  };

  logging: {
    format: 'json' | 'pretty';
    level: 'debug' | 'info' | 'warn' | 'error';
    actions: boolean;
  };

  telemetry?: {
    posthogApiKey?: string;
    posthogHost?: string;
  };

  apiKeys: Record<string, never>;

  browser?: {
    defaultViewportWidth?: number;
    defaultViewportHeight?: number;
  };

  circuitBreaker?: {
    timeout?: number;
    errorThresholdPercentage?: number;
    resetTimeout?: number;
  };

  cors?: {
    enabled?: boolean;
    origins?: string[];
    allowAnyLocalhost?: boolean;
  };
}

interface ServiceConfig {
  protocol: string;
  host: string;
  port: number;
}

/**
 * Build URL from service configuration
 * @param service - Service configuration
 * @param forCluster - If true, use host.docker.internal instead of the config host (for containers)
 */
export function buildServiceUrl(
  service: ServiceConfig,
  forCluster: boolean = false,
): string {
  let host: string;
  if (forCluster) {
    const isLocalhost =
      service.host === 'localhost' || service.host === '127.0.0.1';
    host = isLocalhost ? 'host.docker.internal' : service.host;
  } else {
    host = service.host;
  }
  return `${service.protocol}://${host}:${service.port}`;
}

export interface RegistryCredential {
  registryUrl: string;
  username: string;
  password: string;
}

// Runtime configuration (environment-specific values)
export interface RuntimeConfig {
  namespace?: string;
  apiKey?: string;
  namespaceItemId?: string;
  instanceItemName?: string;
  databaseType?: string;
  databasePort?: string;
}
