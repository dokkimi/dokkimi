import { Injectable, Logger } from '@nestjs/common';
import { RegistryCredential } from '@dokkimi/config';
import { KubernetesClientService } from './kubernetes/kubernetes-client.service';
import { is404Error, is409Error, sleep } from './kubernetes/kubernetes-helpers';

export type { RegistryCredential };

const SYSTEM_NAMESPACE = 'dokkimi-system';
const SECRET_PREFIX = 'run-';
const SECRET_SUFFIX = '-registry-creds';
const COPIED_SECRET_NAME = 'registry-creds';
const SERVICE_ACCOUNT_NAME = 'interceptor-service-account';
const LABEL_RUN_ID = 'dokkimi.io/run-id';
const LABEL_RESOURCE_TYPE = 'dokkimi.io/resource-type';
const RESOURCE_TYPE_VALUE = 'registry-credentials';

@Injectable()
export class RegistryCredentialsService {
  private readonly logger = new Logger(RegistryCredentialsService.name);

  constructor(private readonly k8sClient: KubernetesClientService) {}

  /**
   * Creates a K8s dockerconfigjson secret in dokkimi-system for the given run.
   * Called during run creation when credentials are provided.
   */
  async createRunSecret(
    runId: string,
    credentials: RegistryCredential[],
  ): Promise<void> {
    if (credentials.length === 0) {
      return;
    }

    const dockerConfigJson = this.buildDockerConfigJson(credentials);
    const secretName = this.getSecretName(runId);

    try {
      await this.k8sClient.core.createNamespacedSecret({
        namespace: SYSTEM_NAMESPACE,
        body: {
          metadata: {
            name: secretName,
            namespace: SYSTEM_NAMESPACE,
            labels: {
              [LABEL_RUN_ID]: runId,
              [LABEL_RESOURCE_TYPE]: RESOURCE_TYPE_VALUE,
            },
          },
          type: 'kubernetes.io/dockerconfigjson',
          data: {
            '.dockerconfigjson':
              Buffer.from(dockerConfigJson).toString('base64'),
          },
        },
      });
      this.logger.log(
        `Created registry credentials secret for run ${runId} (${credentials.length} registries)`,
      );
    } catch (err) {
      if (is409Error(err)) {
        this.logger.log(
          `Registry credentials secret for run ${runId} already exists`,
        );
        return;
      }
      throw err;
    }
  }

  /**
   * Copies the run's registry credential secret into a target namespace
   * and patches the default service account with imagePullSecrets.
   */
  async copyToNamespace(runId: string, targetNamespace: string): Promise<void> {
    const secretName = this.getSecretName(runId);

    // Read the source secret from dokkimi-system
    let sourceData: Record<string, string> | undefined;
    try {
      const response = await this.k8sClient.core.readNamespacedSecret({
        name: secretName,
        namespace: SYSTEM_NAMESPACE,
      });
      const secret =
        (response as { body?: { data?: Record<string, string> } }).body ||
        (response as { data?: Record<string, string> });
      sourceData = secret.data;
    } catch (err) {
      if (is404Error(err)) {
        // No credentials for this run — nothing to do
        return;
      }
      throw err;
    }

    if (!sourceData) {
      return;
    }

    // Create the secret in the target namespace
    try {
      await this.k8sClient.core.createNamespacedSecret({
        namespace: targetNamespace,
        body: {
          metadata: {
            name: COPIED_SECRET_NAME,
            namespace: targetNamespace,
          },
          type: 'kubernetes.io/dockerconfigjson',
          data: sourceData,
        },
      });
    } catch (err) {
      if (is409Error(err)) {
        this.logger.log(
          `Registry credentials secret already exists in ${targetNamespace}`,
        );
      } else {
        throw err;
      }
    }

    // Patch the default service account with imagePullSecrets.
    // The default SA is created asynchronously after namespace creation,
    // so we retry until it exists.
    await this.patchServiceAccountImagePullSecrets(targetNamespace);

    this.logger.log(
      `Copied registry credentials to namespace ${targetNamespace}`,
    );
  }

  /**
   * Deletes the run-scoped registry credential secret from dokkimi-system.
   * Called during run teardown.
   */
  async deleteRunSecret(runId: string): Promise<void> {
    const secretName = this.getSecretName(runId);
    try {
      await this.k8sClient.core.deleteNamespacedSecret({
        name: secretName,
        namespace: SYSTEM_NAMESPACE,
      });
      this.logger.log(`Deleted registry credentials secret for run ${runId}`);
    } catch (err) {
      if (is404Error(err)) {
        // Already gone — fine
        return;
      }
      throw err;
    }
  }

  /**
   * Deletes all orphaned registry credential secrets from dokkimi-system.
   * Called by cleanup routines to catch secrets from crashed runs.
   */
  async deleteAllRegistrySecrets(): Promise<void> {
    try {
      const response = await this.k8sClient.core.listNamespacedSecret({
        namespace: SYSTEM_NAMESPACE,
        labelSelector: `${LABEL_RESOURCE_TYPE}=${RESOURCE_TYPE_VALUE}`,
      });
      const secrets =
        (
          response as {
            body?: { items?: Array<{ metadata?: { name?: string } }> };
          }
        ).body?.items ||
        (response as { items?: Array<{ metadata?: { name?: string } }> })
          .items ||
        [];

      for (const secret of secrets) {
        const name = secret.metadata?.name;
        if (!name) {
          continue;
        }
        try {
          await this.k8sClient.core.deleteNamespacedSecret({
            name,
            namespace: SYSTEM_NAMESPACE,
          });
          this.logger.log(`Deleted orphaned registry secret: ${name}`);
        } catch (err) {
          if (!is404Error(err)) {
            this.logger.warn(
              `Failed to delete orphaned registry secret ${name}:`,
              err,
            );
          }
        }
      }
    } catch (err) {
      this.logger.warn(
        'Failed to list registry credential secrets for cleanup:',
        err,
      );
    }
  }

  /**
   * Checks if a run has registry credentials stored in K8s.
   */
  async hasRunSecret(runId: string): Promise<boolean> {
    try {
      await this.k8sClient.core.readNamespacedSecret({
        name: this.getSecretName(runId),
        namespace: SYSTEM_NAMESPACE,
      });
      return true;
    } catch (err) {
      if (is404Error(err)) {
        return false;
      }
      throw err;
    }
  }

  // ============================================
  // PRIVATE
  // ============================================

  private getSecretName(runId: string): string {
    return `${SECRET_PREFIX}${runId}${SECRET_SUFFIX}`;
  }

  private buildDockerConfigJson(credentials: RegistryCredential[]): string {
    const auths: Record<string, { auth: string }> = {};
    for (const cred of credentials) {
      auths[cred.registryUrl] = {
        auth: Buffer.from(`${cred.username}:${cred.password}`).toString(
          'base64',
        ),
      };
    }
    return JSON.stringify({ auths });
  }

  /**
   * Patches the interceptor service account in a namespace with imagePullSecrets.
   * User service pods use this SA, so imagePullSecrets must be set here
   * (not on the default SA) for K8s to use them during image pulls.
   * Retries because the SA may not exist yet when this is called.
   */
  private async patchServiceAccountImagePullSecrets(
    namespace: string,
  ): Promise<void> {
    const maxAttempts = 10;
    const delayMs = 500;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // Read the current SA, then update it with imagePullSecrets.
        // We use read+replace instead of patch because the K8s client's
        // patch API defaults to JSON Patch content type, which requires
        // an array of operations rather than a merge object.
        const response = await this.k8sClient.core.readNamespacedServiceAccount(
          {
            name: SERVICE_ACCOUNT_NAME,
            namespace,
          },
        );
        const sa =
          (response as { body?: Record<string, unknown> }).body ||
          (response as Record<string, unknown>);

        const existing =
          (sa as { imagePullSecrets?: Array<{ name: string }> })
            .imagePullSecrets || [];
        const alreadyHas = existing.some((s) => s.name === COPIED_SECRET_NAME);
        if (alreadyHas) {
          return;
        }

        await this.k8sClient.core.replaceNamespacedServiceAccount({
          name: SERVICE_ACCOUNT_NAME,
          namespace,
          body: {
            ...sa,
            imagePullSecrets: [...existing, { name: COPIED_SECRET_NAME }],
          },
        });
        return;
      } catch (err) {
        if ((is404Error(err) || is409Error(err)) && attempt < maxAttempts - 1) {
          await sleep(delayMs);
          continue;
        }
        throw err;
      }
    }
  }
}
