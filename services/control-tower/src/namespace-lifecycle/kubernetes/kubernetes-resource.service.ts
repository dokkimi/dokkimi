import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { KubernetesClientService } from './kubernetes-client.service';
import { is404Error, is409Error, withRetry } from './kubernetes-helpers';

@Injectable()
export class KubernetesResourceService {
  private readonly logger = new Logger(KubernetesResourceService.name);

  constructor(private readonly k8sClient: KubernetesClientService) {}

  // ============================================
  // DEPLOYMENT OPERATIONS
  // ============================================

  async createDeployment(
    namespace: string,
    deployment: k8s.V1Deployment,
  ): Promise<void> {
    await withRetry(
      async () => {
        try {
          await this.k8sClient.apps.createNamespacedDeployment({
            namespace,
            body: deployment,
          });
        } catch (error: unknown) {
          if (is409Error(error)) {
            this.logger.log(
              `Deployment ${deployment.metadata?.name} already exists in namespace ${namespace}`,
            );
            return;
          }
          throw error;
        }
      },
      this.logger,
      `create deployment ${deployment.metadata?.name}`,
    );
  }

  // ============================================
  // SERVICE OPERATIONS
  // ============================================

  async createService(
    namespace: string,
    service: k8s.V1Service,
  ): Promise<void> {
    await withRetry(
      async () => {
        try {
          await this.k8sClient.core.createNamespacedService({
            namespace,
            body: service,
          });
        } catch (error: unknown) {
          if (is409Error(error)) {
            this.logger.log(
              `Service ${service.metadata?.name} already exists in namespace ${namespace}`,
            );
            return;
          }
          throw error;
        }
      },
      this.logger,
      `create service ${service.metadata?.name}`,
    );
  }

  // ============================================
  // CONFIGMAP OPERATIONS
  // ============================================

  async createConfigMap(
    namespace: string,
    configMap: k8s.V1ConfigMap,
  ): Promise<void> {
    await withRetry(
      async () => {
        try {
          await this.k8sClient.core.createNamespacedConfigMap({
            namespace,
            body: configMap,
          });
          this.logger.log(
            `Created ConfigMap ${configMap.metadata?.name} in namespace ${namespace}`,
          );
        } catch (error: unknown) {
          if (is409Error(error)) {
            this.logger.log(
              `ConfigMap ${configMap.metadata?.name} already exists, updating...`,
            );
            await this.updateConfigMap(namespace, configMap);
            return;
          }
          throw error;
        }
      },
      this.logger,
      `create ConfigMap ${configMap.metadata?.name}`,
    );
  }

  async updateConfigMap(
    namespace: string,
    configMap: k8s.V1ConfigMap,
  ): Promise<void> {
    if (!configMap.metadata?.name) {
      throw new Error('ConfigMap name is required');
    }

    const configMapName = configMap.metadata.name;

    await withRetry(
      async () => {
        try {
          await this.k8sClient.core.replaceNamespacedConfigMap({
            name: configMapName,
            namespace,
            body: configMap,
          });
          this.logger.log(
            `Updated ConfigMap ${configMapName} in namespace ${namespace}`,
          );
        } catch (error: unknown) {
          if (is404Error(error)) {
            this.logger.log(
              `ConfigMap ${configMapName} does not exist, creating...`,
            );
            await this.createConfigMap(namespace, configMap);
            return;
          }
          throw error;
        }
      },
      this.logger,
      `update ConfigMap ${configMapName}`,
    );
  }

  async createOrUpdateConfigMap(
    namespace: string,
    configMap: k8s.V1ConfigMap,
  ): Promise<void> {
    if (!configMap.metadata?.name) {
      throw new Error('ConfigMap name is required');
    }

    const configMapName = configMap.metadata.name;

    await withRetry(
      async () => {
        try {
          await this.k8sClient.core.replaceNamespacedConfigMap({
            name: configMapName,
            namespace,
            body: configMap,
          });
          this.logger.log(
            `Updated ConfigMap ${configMapName} in namespace ${namespace}`,
          );
        } catch (error: unknown) {
          if (is404Error(error)) {
            try {
              await this.k8sClient.core.createNamespacedConfigMap({
                namespace,
                body: configMap,
              });
              this.logger.log(
                `Created ConfigMap ${configMapName} in namespace ${namespace}`,
              );
            } catch (createError: unknown) {
              if (is409Error(createError)) {
                this.logger.log(
                  `ConfigMap ${configMapName} already exists, updating...`,
                );
                await this.k8sClient.core.replaceNamespacedConfigMap({
                  name: configMapName,
                  namespace,
                  body: configMap,
                });
              } else {
                throw createError;
              }
            }
            return;
          }
          throw error;
        }
      },
      this.logger,
      `createOrUpdate ConfigMap ${configMapName}`,
    );
  }

  async deleteConfigMap(namespace: string, name: string): Promise<void> {
    await withRetry(
      async () => {
        try {
          await this.k8sClient.core.deleteNamespacedConfigMap({
            name,
            namespace,
          });
          this.logger.log(
            `Deleted ConfigMap ${name} from namespace ${namespace}`,
          );
        } catch (error: unknown) {
          if (is404Error(error)) {
            this.logger.log(`ConfigMap ${name} does not exist`);
            return;
          }
          throw error;
        }
      },
      this.logger,
      `delete ConfigMap ${name}`,
    );
  }

  // ============================================
  // INGRESS OPERATIONS
  // ============================================

  async createIngress(
    namespace: string,
    ingress: k8s.V1Ingress,
  ): Promise<void> {
    await withRetry(
      async () => {
        try {
          await this.k8sClient.networking.createNamespacedIngress({
            namespace,
            body: ingress,
          });
          this.logger.log(
            `Created Ingress ${ingress.metadata?.name} in namespace ${namespace}`,
          );
        } catch (error: unknown) {
          if (is409Error(error)) {
            this.logger.log(
              `Ingress ${ingress.metadata?.name} already exists, updating...`,
            );
            await this.updateIngress(namespace, ingress);
            return;
          }
          throw error;
        }
      },
      this.logger,
      `create Ingress ${ingress.metadata?.name}`,
    );
  }

  async updateIngress(
    namespace: string,
    ingress: k8s.V1Ingress,
  ): Promise<void> {
    if (!ingress.metadata?.name) {
      throw new Error('Ingress name is required');
    }
    await withRetry(
      async () => {
        await this.k8sClient.networking.replaceNamespacedIngress({
          name: ingress.metadata!.name!,
          namespace,
          body: ingress,
        });
        this.logger.log(
          `Updated Ingress ${ingress.metadata?.name} in namespace ${namespace}`,
        );
      },
      this.logger,
      `update Ingress ${ingress.metadata?.name}`,
    );
  }

  async deleteIngress(namespace: string, name: string): Promise<void> {
    await withRetry(
      async () => {
        try {
          await this.k8sClient.networking.deleteNamespacedIngress({
            name,
            namespace,
          });
          this.logger.log(
            `Deleted Ingress ${name} from namespace ${namespace}`,
          );
        } catch (error: unknown) {
          if (is404Error(error)) {
            this.logger.log(`Ingress ${name} does not exist`);
            return;
          }
          throw error;
        }
      },
      this.logger,
      `delete Ingress ${name}`,
    );
  }

  // ============================================
  // RBAC OPERATIONS
  // ============================================

  async createServiceAccount(
    namespace: string,
    serviceAccount: k8s.V1ServiceAccount,
  ): Promise<void> {
    await withRetry(
      async () => {
        try {
          await this.k8sClient.core.createNamespacedServiceAccount({
            namespace,
            body: serviceAccount,
          });
          this.logger.log(
            `Created ServiceAccount ${serviceAccount.metadata?.name} in namespace ${namespace}`,
          );
        } catch (error: unknown) {
          if (is409Error(error)) {
            this.logger.log(
              `ServiceAccount ${serviceAccount.metadata?.name} already exists in namespace ${namespace}`,
            );
            return;
          }
          this.logger.error(
            `Failed to create ServiceAccount ${serviceAccount.metadata?.name}:`,
            error,
          );
          throw error;
        }
      },
      this.logger,
      `create ServiceAccount ${serviceAccount.metadata?.name}`,
    );
  }

  async createRole(namespace: string, role: k8s.V1Role): Promise<void> {
    await withRetry(
      async () => {
        try {
          await this.k8sClient.rbac.createNamespacedRole({
            namespace,
            body: role,
          });
          this.logger.log(
            `Created Role ${role.metadata?.name} in namespace ${namespace}`,
          );
        } catch (error: unknown) {
          if (is409Error(error)) {
            this.logger.log(
              `Role ${role.metadata?.name} already exists in namespace ${namespace}`,
            );
            return;
          }
          this.logger.error(
            `Failed to create Role ${role.metadata?.name}:`,
            error,
          );
          throw error;
        }
      },
      this.logger,
      `create Role ${role.metadata?.name}`,
    );
  }

  async createRoleBinding(
    namespace: string,
    roleBinding: k8s.V1RoleBinding,
  ): Promise<void> {
    await withRetry(
      async () => {
        try {
          await this.k8sClient.rbac.createNamespacedRoleBinding({
            namespace,
            body: roleBinding,
          });
          this.logger.log(
            `Created RoleBinding ${roleBinding.metadata?.name} in namespace ${namespace}`,
          );
        } catch (error: unknown) {
          if (is409Error(error)) {
            this.logger.log(
              `RoleBinding ${roleBinding.metadata?.name} already exists in namespace ${namespace}`,
            );
            return;
          }
          this.logger.error(
            `Failed to create RoleBinding ${roleBinding.metadata?.name}:`,
            error,
          );
          throw error;
        }
      },
      this.logger,
      `create RoleBinding ${roleBinding.metadata?.name}`,
    );
  }

  async getService(
    namespace: string,
    serviceName: string,
  ): Promise<k8s.V1Service> {
    try {
      const response = await this.k8sClient.core.readNamespacedService({
        name: serviceName,
        namespace,
      });
      const service = (response as { body?: k8s.V1Service }).body || response;
      if (!service || !service.metadata) {
        throw new Error(
          `Invalid response from Kubernetes API for service ${serviceName}`,
        );
      }
      return service;
    } catch (error: unknown) {
      if (is404Error(error)) {
        throw new Error(
          `Service ${serviceName} not found in namespace ${namespace}`,
          { cause: error },
        );
      }
      throw error;
    }
  }
}
