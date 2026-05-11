import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { KubernetesResourceService } from '../kubernetes/kubernetes-resource.service';
import { getConfig, buildInterceptorEnvVars } from '@dokkimi/config';
import { DeployableItem } from './instance-item-creator.service';
import { DOKKIMI_IMAGES } from '../../constants/image-tags';

@Injectable()
export class ServiceInterceptorCreatorService {
  private readonly logger = new Logger(ServiceInterceptorCreatorService.name);

  constructor(private readonly k8sResource: KubernetesResourceService) {}

  /**
   * Creates a per-service interceptor pod and returns its ClusterIP
   * @returns The ClusterIP of the interceptor service
   */
  async create(
    k8sNamespace: string,
    instanceId: string,
    item: DeployableItem,
    instanceItemId: string,
    k8sDnsIP: string,
    allServicePorts: number[],
  ): Promise<{ clusterIP: string }> {
    const interceptorServiceName = `${item.k8sName}-interceptor`;

    try {
      // 1. Create K8s Service for this interceptor (e.g., "service-a-interceptor")
      const service = this.buildInterceptorService(
        interceptorServiceName,
        k8sNamespace,
        allServicePorts,
      );
      await this.k8sResource.createService(k8sNamespace, service);

      // 2. Read back the assigned ClusterIP (K8s assigns it synchronously on Service creation)
      const createdService = await this.k8sResource.getService(
        k8sNamespace,
        interceptorServiceName,
      );
      const clusterIP: string | undefined = createdService.spec?.clusterIP;

      if (!clusterIP) {
        throw new Error(
          `Failed to get ClusterIP for interceptor service ${interceptorServiceName}`,
        );
      }

      this.logger.log(
        `Created interceptor service ${interceptorServiceName} with ClusterIP ${clusterIP}`,
      );

      // 3. Create interceptor deployment (uses K8s DNS directly, no dnsmasq)
      const deployment = this.buildInterceptorDeployment(
        interceptorServiceName,
        item,
        k8sNamespace,
        instanceId,
        k8sDnsIP,
        instanceItemId,
      );
      await this.k8sResource.createDeployment(k8sNamespace, deployment);

      this.logger.log(
        `Created interceptor deployment for service ${item.name} (${interceptorServiceName})`,
      );

      // 4. Return ClusterIP for use in service's dnsmasq config
      return { clusterIP };
    } catch (error: unknown) {
      this.logger.error(
        `Failed to create interceptor for service ${item.name}:`,
        error,
      );
      throw error;
    }
  }

  private buildInterceptorService(
    serviceName: string,
    k8sNamespace: string,
    allServicePorts: number[],
  ): k8s.V1Service {
    const config = getConfig();
    const interceptorPort = config.services.interceptor.port;

    // Always expose 80 (standard HTTP) and 443 (HTTPS).
    // Also expose every port used by services in the namespace so that
    // traffic on non-standard ports (e.g., http://control-tower:3001)
    // still routes through the interceptor instead of failing.
    const portSet = new Set([80, ...allServicePorts]);
    const ports: k8s.V1ServicePort[] = [
      ...Array.from(portSet).map((p) => ({
        port: p,
        targetPort: interceptorPort,
        name: `port-${p}`,
      })),
      {
        port: 443,
        targetPort: 443,
        name: 'https',
      },
    ];

    return {
      metadata: {
        name: serviceName,
        namespace: k8sNamespace,
        labels: {
          app: serviceName,
        },
      },
      spec: {
        selector: {
          app: serviceName,
        },
        ports,
      },
    };
  }

  private buildInterceptorDeployment(
    deploymentName: string,
    item: DeployableItem,
    k8sNamespace: string,
    instanceId: string,
    k8sDnsIP: string,
    instanceItemId: string,
  ): k8s.V1Deployment {
    const config = getConfig();

    // Build type-safe environment variables for per-service interceptor
    const envVars = buildInterceptorEnvVars(config, {
      namespace: instanceId,
      k8sNamespace: k8sNamespace,
      apiKey: 'dokkimi-interceptor-key', // Default API key for internal service communication
      k8sDnsIP,
      origin: item.name, // Service this interceptor handles
      instanceItemName: item.name,
      healthCheckEndpoint: item.healthCheck || undefined,
      servicePort: '80',
      namespaceItemId: instanceItemId,
      testAgentUrl: `http://test-agent-service:${config.services.testAgent.port}`,
    });

    return {
      metadata: {
        name: deploymentName,
        namespace: k8sNamespace,
        labels: {
          app: deploymentName,
        },
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: {
            app: deploymentName,
          },
        },
        template: {
          metadata: {
            labels: {
              app: deploymentName,
              'dokkimi.io/instance-id': instanceId,
            },
          },
          spec: {
            serviceAccountName: 'interceptor-service-account',
            volumes: [
              {
                name: 'dokkimi-ca',
                secret: { secretName: 'dokkimi-ca', optional: true },
              },
            ],
            containers: [
              {
                name: 'interceptor',
                image: DOKKIMI_IMAGES.interceptor,
                imagePullPolicy: 'IfNotPresent',
                ports: [
                  { containerPort: config.services.interceptor.port },
                  { containerPort: 443 },
                ],
                env: [
                  ...envVars,
                  {
                    name: 'DOKKIMI_CA_CERT_PATH',
                    value: '/etc/dokkimi/ca/tls.crt',
                  },
                  {
                    name: 'DOKKIMI_CA_KEY_PATH',
                    value: '/etc/dokkimi/ca/tls.key',
                  },
                ],
                volumeMounts: [
                  {
                    name: 'dokkimi-ca',
                    mountPath: '/etc/dokkimi/ca',
                    readOnly: true,
                  },
                ],
                readinessProbe: {
                  httpGet: {
                    path: '/health',
                    port: config.services.interceptor.port,
                  },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                },
                livenessProbe: {
                  httpGet: {
                    path: '/health',
                    port: config.services.interceptor.port,
                  },
                  initialDelaySeconds: 10,
                  periodSeconds: 30,
                },
              },
            ],
          },
        },
      },
    };
  }
}
