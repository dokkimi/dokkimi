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

  images: {
    databases: Record<string, string>;
    brokers: Record<string, string>;
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

export function buildServiceUrl(service: ServiceConfig): string {
  return `${service.protocol}://${service.host}:${service.port}`;
}

export function buildClusterServiceUrl(service: ServiceConfig): string {
  const isLocal =
    service.host === 'localhost' ||
    service.host === '127.0.0.1' ||
    service.host === '0.0.0.0';
  const host = isLocal ? 'host.docker.internal' : service.host;
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
