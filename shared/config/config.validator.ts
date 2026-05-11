import { DokkimiConfig } from './config.types';

export function validateConfig(config: DokkimiConfig): string[] {
  const errors: string[] = [];

  // Validate services
  if (!config.services) {
    errors.push('services configuration is required');
  } else {
    validateServiceConfig(
      'services.controlTower',
      config.services.controlTower,
      errors,
    );

    validatePort(
      'services.interceptor.port',
      config.services.interceptor?.port,
      errors,
    );
    validatePort(
      'services.testAgent.port',
      config.services.testAgent?.port,
      errors,
    );
    validatePort(
      'services.chromium.port',
      config.services.chromium?.port,
      errors,
    );
  }

  // Validate cluster watcher poll intervals
  if (!config.clusterWatcher) {
    errors.push('clusterWatcher is required');
  } else {
    if (
      typeof config.clusterWatcher.idlePollIntervalMs !== 'number' ||
      config.clusterWatcher.idlePollIntervalMs <= 0
    ) {
      errors.push(
        'clusterWatcher.idlePollIntervalMs must be a positive number',
      );
    }
    if (
      typeof config.clusterWatcher.activePollIntervalMs !== 'number' ||
      config.clusterWatcher.activePollIntervalMs <= 0
    ) {
      errors.push(
        'clusterWatcher.activePollIntervalMs must be a positive number',
      );
    }
  }

  // Validate kubernetes
  if (!config.kubernetes) {
    errors.push('kubernetes configuration is required');
  } else {
    if (!config.kubernetes.dnsIP) {
      errors.push('kubernetes.dnsIP is required');
    }
    if (!config.kubernetes.namespacePrefix) {
      errors.push('kubernetes.namespacePrefix is required');
    }
    if (
      typeof config.kubernetes.maxConcurrentNamespaces !== 'number' ||
      !Number.isInteger(config.kubernetes.maxConcurrentNamespaces) ||
      config.kubernetes.maxConcurrentNamespaces < 1
    ) {
      errors.push(
        'kubernetes.maxConcurrentNamespaces must be a positive integer (>= 1)',
      );
    }
    if (
      typeof config.kubernetes.maxBootingNamespaces !== 'number' ||
      !Number.isInteger(config.kubernetes.maxBootingNamespaces) ||
      config.kubernetes.maxBootingNamespaces < 1
    ) {
      errors.push(
        'kubernetes.maxBootingNamespaces must be a positive integer (>= 1)',
      );
    }
  }

  // Validate network
  if (!config.network) {
    errors.push('network configuration is required');
  }

  // Validate timeouts
  if (!config.timeouts) {
    errors.push('timeouts configuration is required');
  } else {
    if (
      typeof config.timeouts.httpRequest !== 'number' ||
      config.timeouts.httpRequest <= 0
    ) {
      errors.push('timeouts.httpRequest must be a positive number');
    }
    if (
      typeof config.timeouts.metricsInterval !== 'number' ||
      config.timeouts.metricsInterval <= 0
    ) {
      errors.push('timeouts.metricsInterval must be a positive number');
    }
  }

  return errors;
}

function validateServiceConfig(
  path: string,
  service: { host: string; port: number; protocol: string } | undefined,
  errors: string[],
): void {
  if (!service) {
    errors.push(`${path} is required`);
    return;
  }

  if (!service.host) {
    errors.push(`${path}.host is required`);
  }

  if (
    typeof service.port !== 'number' ||
    service.port <= 0 ||
    service.port > 65535
  ) {
    errors.push(`${path}.port must be a valid port number (1-65535)`);
  }

  if (!service.protocol) {
    errors.push(`${path}.protocol is required`);
  } else if (!['http', 'https'].includes(service.protocol)) {
    errors.push(`${path}.protocol must be 'http' or 'https'`);
  }
}

function validatePort(
  path: string,
  port: number | undefined,
  errors: string[],
): void {
  if (port === undefined) {
    errors.push(`${path} is required`);
  } else if (typeof port !== 'number' || port <= 0 || port > 65535) {
    errors.push(`${path} must be a valid port number (1-65535)`);
  }
}
