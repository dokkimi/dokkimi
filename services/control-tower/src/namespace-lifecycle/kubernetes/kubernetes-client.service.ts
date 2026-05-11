import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { is404Error, is409Error, sleep, withRetry } from './kubernetes-helpers';
import { loadKubeConfig } from './kubeconfig-loader';

@Injectable()
export class KubernetesClientService {
  private readonly logger = new Logger(KubernetesClientService.name);
  private readonly k8sConfig: k8s.KubeConfig;
  private readonly coreApi: k8s.CoreV1Api;
  private readonly appsApi: k8s.AppsV1Api;
  private readonly networkingApi: k8s.NetworkingV1Api;
  private readonly storageApi: k8s.StorageV1Api;
  private readonly rbacApi: k8s.RbacAuthorizationV1Api;

  constructor() {
    this.k8sConfig = loadKubeConfig();
    this.coreApi = this.k8sConfig.makeApiClient(k8s.CoreV1Api);
    this.appsApi = this.k8sConfig.makeApiClient(k8s.AppsV1Api);
    this.networkingApi = this.k8sConfig.makeApiClient(k8s.NetworkingV1Api);
    this.storageApi = this.k8sConfig.makeApiClient(k8s.StorageV1Api);
    this.rbacApi = this.k8sConfig.makeApiClient(k8s.RbacAuthorizationV1Api);
  }

  // ============================================
  // API CLIENT ACCESSORS
  // ============================================

  getKubeConfig(): k8s.KubeConfig {
    return this.k8sConfig;
  }

  get core(): k8s.CoreV1Api {
    return this.coreApi;
  }

  get apps(): k8s.AppsV1Api {
    return this.appsApi;
  }

  get networking(): k8s.NetworkingV1Api {
    return this.networkingApi;
  }

  get storage(): k8s.StorageV1Api {
    return this.storageApi;
  }

  get rbac(): k8s.RbacAuthorizationV1Api {
    return this.rbacApi;
  }

  // ============================================
  // NAMESPACE OPERATIONS
  // ============================================

  async createNamespace(
    name: string,
    labels?: Record<string, string>,
  ): Promise<void> {
    await withRetry(
      async () => {
        try {
          const namespace: k8s.V1Namespace = {
            metadata: {
              name,
              labels: {
                'app.kubernetes.io/name': 'dokkimi',
                'app.kubernetes.io/component': 'namespace',
                ...labels,
              },
            },
          };

          await this.coreApi.createNamespace({ body: namespace });
          this.logger.log(`Created Kubernetes namespace: ${name}`);
        } catch (error: unknown) {
          if (is409Error(error)) {
            this.logger.log(`Kubernetes namespace ${name} already exists`);
            return;
          }
          throw error;
        }
      },
      this.logger,
      `create namespace ${name}`,
    );
  }

  async deleteNamespace(name: string): Promise<void> {
    await withRetry(
      async () => {
        try {
          await this.deleteAllDeployments(name);
          await this.coreApi.deleteNamespace({ name });
          this.logger.log(`Deleted Kubernetes namespace: ${name}`);
        } catch (error: unknown) {
          if (is404Error(error)) {
            this.logger.log(`Kubernetes namespace ${name} does not exist`);
            return;
          }
          throw error;
        }
      },
      this.logger,
      `delete namespace ${name}`,
    );
  }

  private async deleteAllDeployments(namespace: string): Promise<void> {
    try {
      const response = await this.appsApi.listNamespacedDeployment({
        namespace,
      });
      const deployments =
        (response as { body?: k8s.V1DeploymentList }).body?.items ||
        (response as k8s.V1DeploymentList).items ||
        [];

      await Promise.all(
        deployments.map(async (dep) => {
          const depName = dep.metadata?.name;
          if (!depName) {
            return;
          }
          try {
            await this.appsApi.deleteNamespacedDeployment({
              name: depName,
              namespace,
              body: {
                gracePeriodSeconds: 0,
                propagationPolicy: 'Foreground',
              },
            });
          } catch (error: unknown) {
            if (!is404Error(error)) {
              this.logger.warn(
                `Failed to delete deployment ${depName} in ${namespace}: ${error}`,
              );
            }
          }
        }),
      );
    } catch (error: unknown) {
      if (!is404Error(error)) {
        this.logger.warn(
          `Failed to list deployments in ${namespace}: ${error}`,
        );
      }
    }
  }

  // ============================================
  // NAMESPACE UTILITY OPERATIONS
  // ============================================

  async namespaceExists(name: string): Promise<boolean> {
    try {
      await this.coreApi.readNamespace({ name });
      return true;
    } catch (error: unknown) {
      if (is404Error(error)) {
        return false;
      }
      throw error;
    }
  }

  async getNamespace(name: string): Promise<k8s.V1Namespace | null> {
    try {
      const response = await this.coreApi.readNamespace({ name });
      return (response as { body: k8s.V1Namespace }).body;
    } catch (error: unknown) {
      if (is404Error(error)) {
        return null;
      }
      throw error;
    }
  }

  async isNamespaceTerminating(name: string): Promise<boolean> {
    const ns = await this.getNamespace(name);
    return ns?.metadata?.deletionTimestamp != null;
  }

  async waitForNamespaceDeletion(
    name: string,
    timeoutMs: number = 60000,
    pollIntervalMs: number = 1000,
  ): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const exists = await this.namespaceExists(name);
      if (!exists) {
        return true;
      }
      await sleep(pollIntervalMs);
    }

    return false;
  }

  // ============================================
  // DNS UTILITY
  // ============================================

  async getKubeDnsClusterIP(): Promise<string> {
    try {
      const response = await this.coreApi.readNamespacedService({
        name: 'kube-dns',
        namespace: 'kube-system',
      });
      const service = (response as { body?: k8s.V1Service }).body || response;
      const clusterIP = service?.spec?.clusterIP;
      if (clusterIP) {
        this.logger.log(`Discovered kube-dns ClusterIP: ${clusterIP}`);
        return clusterIP;
      }
    } catch (error: unknown) {
      this.logger.warn('Failed to get kube-dns ClusterIP dynamically:', error);
    }

    const { getConfig } = await import('@dokkimi/config');
    const fallbackIP = getConfig().kubernetes.dnsIP;
    this.logger.log(`Using fallback kube-dns IP from config: ${fallbackIP}`);
    return fallbackIP;
  }
}
