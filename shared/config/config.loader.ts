import * as fs from 'fs';
import * as os from 'os';
import * as yaml from 'js-yaml';
import * as path from 'path';
import { DokkimiConfig, RuntimeConfig } from './config.types';
import { validateConfig } from './config.validator';

export class ConfigLoader {
  private static instance: ConfigLoader;
  private config: DokkimiConfig | null = null;

  private constructor() {}

  public static getInstance(): ConfigLoader {
    if (!ConfigLoader.instance) {
      ConfigLoader.instance = new ConfigLoader();
    }
    return ConfigLoader.instance;
  }

  /**
   * Load configuration from YAML file
   * Must be called during application startup before any services initialize
   */
  public load(configPath?: string, options?: { ci?: boolean }): DokkimiConfig {
    if (this.config) {
      return this.config;
    }

    const possiblePaths = [
      path.join(__dirname, '../../../config', 'config.yaml'),
      path.join(__dirname, '../../../../config', 'config.yaml'),
      path.join(process.cwd(), 'config', 'config.yaml'),
    ];

    const defaultPath =
      possiblePaths.find((p) => fs.existsSync(p)) || possiblePaths[0];

    const finalPath = configPath || process.env.CONFIG_PATH || defaultPath;

    if (!fs.existsSync(finalPath)) {
      throw new Error(
        `Configuration file not found: ${finalPath}\n` +
          `Set CONFIG_PATH environment variable or ensure config/config.yaml exists.`,
      );
    }

    const fileContents = fs.readFileSync(finalPath, 'utf8');
    const rawConfig = yaml.load(fileContents) as DokkimiConfig;

    // Validate configuration
    const errors = validateConfig(rawConfig);
    if (errors.length > 0) {
      throw new Error(
        `Configuration validation failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`,
      );
    }

    this.config = this.applyEnvOverrides(
      this.expandTildePaths(rawConfig),
      options?.ci,
    );
    return this.config;
  }

  /**
   * Get loaded configuration
   * Throws if configuration hasn't been loaded yet
   */
  public getConfig(): DokkimiConfig {
    if (!this.config) {
      throw new Error(
        'Configuration not loaded. Call ConfigLoader.load() during application startup.',
      );
    }
    return this.config;
  }

  /**
   * Get runtime configuration from environment variables
   * These are instance-specific values not in the static config files
   */
  public getRuntimeConfig(): RuntimeConfig {
    return {
      namespace: this.getRequiredEnv('NAMESPACE', false),
      k8sNamespace: this.getRequiredEnv('K8S_NAMESPACE', false),
      apiKey: this.getRequiredEnv('API_KEY', false),
      namespaceItemId: process.env.NAMESPACE_ITEM_ID,
      instanceItemName: process.env.INSTANCE_ITEM_NAME,
      databaseType: process.env.DATABASE_TYPE,
      databasePort: process.env.DATABASE_PORT,
    };
  }

  /**
   * Recursively expand ~ to the user's home directory in all string values.
   */
  private expandTildePaths<T>(obj: T): T {
    if (typeof obj === 'string') {
      if (obj.startsWith('~/') || obj === '~') {
        return path.join(os.homedir(), obj.slice(1)) as T;
      }
      // Handle scheme-prefixed paths like file:~/.dokkimi/dokkimi.db
      const schemeMatch = obj.match(/^([a-z][a-z0-9+.-]*:)(~\/.*)$/);
      if (schemeMatch) {
        return (schemeMatch[1] +
          path.join(os.homedir(), schemeMatch[2].slice(1))) as T;
      }
      return obj as T;
    }
    if (Array.isArray(obj)) {
      return obj.map((v) => this.expandTildePaths(v)) as T;
    }
    if (obj && typeof obj === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k] = this.expandTildePaths(v);
      }
      return out as T;
    }
    return obj;
  }

  /**
   * Apply environment variable overrides to the loaded config.
   * Only HOST overrides are supported — Kubernetes auto-injects <SERVICE>_PORT env vars
   * in tcp:// URL format which would corrupt numeric port values.
   */
  private applyEnvOverrides(
    config: DokkimiConfig,
    ci?: boolean,
  ): DokkimiConfig {
    const isCI = ci || !!process.env.CI;
    if (process.env.DATABASE_URL) {
      config.database.url = process.env.DATABASE_URL;
    }
    if (process.env.CONTROL_TOWER_HOST) {
      config.services.controlTower.host = process.env.CONTROL_TOWER_HOST;
    }
    if (process.env.IDLE_POLL_INTERVAL_MS) {
      config.clusterWatcher.idlePollIntervalMs = Number(
        process.env.IDLE_POLL_INTERVAL_MS,
      );
    }
    if (process.env.ACTIVE_POLL_INTERVAL_MS) {
      config.clusterWatcher.activePollIntervalMs = Number(
        process.env.ACTIVE_POLL_INTERVAL_MS,
      );
    }
    if (process.env.DOKKIMI_MAX_CONCURRENT_NAMESPACES) {
      config.kubernetes.maxConcurrentNamespaces = Number(
        process.env.DOKKIMI_MAX_CONCURRENT_NAMESPACES,
      );
    } else if (isCI) {
      config.kubernetes.maxConcurrentNamespaces = 3;
    }
    if (process.env.DOKKIMI_MAX_BOOTING_NAMESPACES) {
      config.kubernetes.maxBootingNamespaces = Number(
        process.env.DOKKIMI_MAX_BOOTING_NAMESPACES,
      );
    } else if (isCI) {
      config.kubernetes.maxBootingNamespaces = 1;
    }
    if (process.env.DOKKIMI_HTTP_TIMEOUT) {
      config.timeouts.httpRequest = Number(process.env.DOKKIMI_HTTP_TIMEOUT);
    }
    if (process.env.DOKKIMI_CIRCUIT_BREAKER_TIMEOUT) {
      if (!config.circuitBreaker) {
        config.circuitBreaker = {};
      }
      config.circuitBreaker.timeout = Number(
        process.env.DOKKIMI_CIRCUIT_BREAKER_TIMEOUT,
      );
    }
    if (process.env.DOKKIMI_CIRCUIT_BREAKER_RESET_TIMEOUT) {
      if (!config.circuitBreaker) {
        config.circuitBreaker = {};
      }
      config.circuitBreaker.resetTimeout = Number(
        process.env.DOKKIMI_CIRCUIT_BREAKER_RESET_TIMEOUT,
      );
    }
    if (process.env.DOKKIMI_DEFAULT_VIEWPORT_WIDTH) {
      if (!config.browser) {
        config.browser = {};
      }
      config.browser.defaultViewportWidth = Number(
        process.env.DOKKIMI_DEFAULT_VIEWPORT_WIDTH,
      );
    }
    if (process.env.DOKKIMI_DEFAULT_VIEWPORT_HEIGHT) {
      if (!config.browser) {
        config.browser = {};
      }
      config.browser.defaultViewportHeight = Number(
        process.env.DOKKIMI_DEFAULT_VIEWPORT_HEIGHT,
      );
    }
    return config;
  }

  /**
   * Helper to get required environment variable
   */
  private getRequiredEnv(
    key: string,
    required: boolean = true,
  ): string | undefined {
    const value = process.env[key];
    if (required && !value) {
      throw new Error(`Required environment variable not set: ${key}`);
    }
    return value;
  }
}

// Convenience exports
export const loadConfig = (configPath?: string, options?: { ci?: boolean }) =>
  ConfigLoader.getInstance().load(configPath, options);

export const getConfig = () => ConfigLoader.getInstance().getConfig();

export const getRuntimeConfig = () =>
  ConfigLoader.getInstance().getRuntimeConfig();
