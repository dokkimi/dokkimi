import { Logger } from '@nestjs/common';

export interface KubernetesApiError {
  body?: {
    code?: number;
    message?: string;
  };
  statusCode?: number;
  code?: number;
}

export function is404Error(error: unknown): boolean {
  const k8sError = error as KubernetesApiError;

  if (k8sError.code === 404) {
    return true;
  }
  if (k8sError.statusCode === 404) {
    return true;
  }

  if (
    k8sError.body &&
    typeof k8sError.body === 'object' &&
    'code' in k8sError.body
  ) {
    if (k8sError.body.code === 404) {
      return true;
    }
  }

  if (typeof k8sError.body === 'string') {
    try {
      const parsed = JSON.parse(k8sError.body);
      if (parsed.code === 404) {
        return true;
      }
    } catch {
      // Ignore JSON parse errors
    }
  }

  return false;
}

export function is409Error(error: unknown): boolean {
  const k8sError = error as KubernetesApiError;

  if (k8sError.code === 409 || k8sError.statusCode === 409) {
    return true;
  }

  if (
    k8sError.body &&
    typeof k8sError.body === 'object' &&
    'code' in k8sError.body
  ) {
    if (k8sError.body.code === 409) {
      return true;
    }
  }

  if (typeof k8sError.body === 'string') {
    try {
      const parsed = JSON.parse(k8sError.body);
      if (parsed.code === 409) {
        return true;
      }
    } catch {
      // Ignore JSON parse errors
    }
  }

  return false;
}

export function shouldRetry(error: unknown): boolean {
  const k8sError = error as KubernetesApiError;
  if (k8sError.statusCode && k8sError.statusCode >= 500) {
    return true;
  }
  if (!k8sError.statusCode && !k8sError.body) {
    return true;
  }
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes an operation with exponential backoff retry on transient failures.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  logger: Logger,
  operationName: string,
  maxRetries = 3,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      if (attempt < maxRetries - 1 && shouldRetry(error)) {
        const delay = Math.pow(2, attempt) * 100;
        logger.warn(
          `Failed ${operationName} (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms...`,
        );
        await sleep(delay);
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}
