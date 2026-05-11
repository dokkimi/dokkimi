import * as k8s from '@kubernetes/client-node';
import { ItemDefinitionLike } from './deployment-builder.types';

/**
 * Safely converts a value to string
 */
function safeStringify(value: unknown): string {
  if (
    value == null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value ?? '');
  }
  return '';
}

/**
 * Builds environment variables from JSON (array or object format)
 */
export function buildEnvVars(env: any): k8s.V1EnvVar[] {
  const envVars: k8s.V1EnvVar[] = [];
  if (!env) {
    return envVars;
  }

  type EnvVarValue = string | number | boolean | null;
  type EnvVarObject = { name: EnvVarValue; value: EnvVarValue };

  if (Array.isArray(env)) {
    for (const envItem of env) {
      if (
        envItem &&
        typeof envItem === 'object' &&
        'name' in envItem &&
        'value' in envItem
      ) {
        const envObj = envItem as EnvVarObject;
        const name = safeStringify(envObj.name);
        const value = safeStringify(envObj.value);
        if (name) {
          envVars.push({ name, value });
        }
      }
    }
  } else if (typeof env === 'object' && env !== null) {
    for (const [key, value] of Object.entries(
      env as Record<string, EnvVarValue>,
    )) {
      envVars.push({
        name: key,
        value: safeStringify(value),
      });
    }
  }

  return envVars;
}

/**
 * Builds resource limits and requests
 */
export function buildResources(
  item: ItemDefinitionLike,
): k8s.V1ResourceRequirements {
  if (!item.minCpu && !item.minMemory && !item.maxCpu && !item.maxMemory) {
    return {};
  }

  return {
    requests: {
      ...(item.minCpu && { cpu: `${item.minCpu}` }),
      ...(item.minMemory && { memory: `${item.minMemory}Mi` }),
    },
    limits: {
      ...(item.maxCpu && { cpu: `${item.maxCpu}` }),
      ...(item.maxMemory && { memory: `${item.maxMemory}Mi` }),
    },
  };
}
