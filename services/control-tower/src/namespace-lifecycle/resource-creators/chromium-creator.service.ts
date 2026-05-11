import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { KubernetesResourceService } from '../kubernetes/kubernetes-resource.service';
import { ServiceDeploymentBuilderService } from '../builders/service-deployment-builder.service';
import { ServiceInterceptorCreatorService } from './service-interceptor-creator.service';
import { DeployableItem } from './instance-item-creator.service';
import { getConfig } from '@dokkimi/config';
import {
  DOKKIMI_IMAGES,
  resolveBrowserImage,
} from '../../constants/image-tags';
import { BrowserConfig } from '../../namespace-deployer/deployment-context.types';

export interface ChromiumCreateOptions {
  k8sNamespace: string;
  instanceId: string;
  k8sDnsIP: string;
  allServiceNames: string[];
  allServicePorts: number[];
  databaseNames: string[];
  browser?: BrowserConfig;
}

@Injectable()
export class ChromiumCreatorService {
  private readonly logger = new Logger(ChromiumCreatorService.name);

  constructor(
    private readonly k8sResource: KubernetesResourceService,
    private readonly serviceInterceptorCreator: ServiceInterceptorCreatorService,
    private readonly serviceDeploymentBuilder: ServiceDeploymentBuilderService,
  ) {}

  async create(options: ChromiumCreateOptions): Promise<void> {
    const config = getConfig();
    const chromiumPort = config.services.chromium.port;
    const {
      k8sNamespace,
      instanceId,
      k8sDnsIP,
      allServiceNames,
      allServicePorts,
      databaseNames,
      browser,
    } = options;

    // Create a per-service interceptor for the chromium pod, same as any
    // other service. All outbound browser traffic routes through it.
    const chromiumItem: DeployableItem = {
      name: 'chromium',
      k8sName: 'chromium',
      type: 'SERVICE',
      image: resolveBrowserImage(browser),
      port: chromiumPort,
      healthCheck: '/json/version',
    };

    const { clusterIP } = await this.serviceInterceptorCreator.create(
      k8sNamespace,
      instanceId,
      chromiumItem,
      'chromium',
      k8sDnsIP,
      allServicePorts,
    );

    // Build dnsmasq config using the same builder as service pods:
    // catch-all address=/#/<interceptorClusterIP>
    const dnsmasqConfigMap =
      this.serviceDeploymentBuilder.buildDnsmasqConfigMapForService(
        'chromium',
        k8sNamespace,
        allServiceNames,
        clusterIP,
        k8sDnsIP,
        databaseNames,
      );
    await this.k8sResource.createOrUpdateConfigMap(
      k8sNamespace,
      dnsmasqConfigMap,
    );

    const deployment = this.buildDeployment(k8sNamespace, instanceId, browser);
    const service = this.buildService(k8sNamespace);

    await this.k8sResource.createDeployment(k8sNamespace, deployment);
    await this.k8sResource.createService(k8sNamespace, service);

    this.logger.log(
      `Created standalone chromium pod in namespace ${k8sNamespace} with interceptor ClusterIP ${clusterIP}`,
    );
  }

  private buildDeployment(
    k8sNamespace: string,
    instanceId: string,
    browser?: BrowserConfig,
  ): k8s.V1Deployment {
    const config = getConfig();
    const chromiumPort = config.services.chromium.port;
    const browserImage = resolveBrowserImage(browser);

    return {
      metadata: {
        name: 'chromium',
        namespace: k8sNamespace,
        labels: {
          app: 'chromium',
        },
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: {
            app: 'chromium',
          },
        },
        template: {
          metadata: {
            labels: {
              app: 'chromium',
              'dokkimi.io/instance-id': instanceId,
            },
          },
          spec: {
            terminationGracePeriodSeconds: 1,
            dnsPolicy: 'None',
            dnsConfig: {
              nameservers: [config.network.dns.nameserver],
              searches: [
                `${k8sNamespace}.svc.cluster.local`,
                'svc.cluster.local',
                'cluster.local',
              ],
              options: [
                { name: 'ndots', value: '2' },
                { name: 'timeout', value: '2' },
              ],
            },
            containers: [
              {
                name: 'chromium',
                image: browserImage,
                imagePullPolicy: 'IfNotPresent',
                args: [
                  '--disable-dev-shm-usage',
                  '--ignore-certificate-errors',
                ],
                ports: [{ containerPort: chromiumPort, name: 'cdp' }],
                readinessProbe: {
                  httpGet: {
                    path: '/json/version',
                    port: chromiumPort,
                  },
                  initialDelaySeconds: 2,
                  periodSeconds: 3,
                  timeoutSeconds: 2,
                  failureThreshold: 5,
                },
                resources: {
                  requests: {
                    cpu: '500m',
                    memory: '512Mi',
                  },
                  limits: {
                    cpu: '2',
                    memory: '2Gi',
                  },
                },
              },
              {
                name: 'dnsmasq',
                image: DOKKIMI_IMAGES.dnsmasq,
                imagePullPolicy: 'IfNotPresent',
                args: ['-k'],
                ports: [
                  { containerPort: 53, protocol: 'UDP' },
                  { containerPort: 53, protocol: 'TCP' },
                ],
                volumeMounts: [
                  {
                    name: 'dnsmasq-config',
                    mountPath: '/etc/dnsmasq.conf',
                    subPath: 'dnsmasq.conf',
                  },
                ],
                resources: {
                  requests: { cpu: '50m', memory: '64Mi' },
                  limits: { cpu: '200m', memory: '128Mi' },
                },
              },
            ],
            volumes: [
              {
                name: 'dnsmasq-config',
                configMap: { name: 'dokkimi-dnsmasq-config-chromium' },
              },
            ],
          },
        },
      },
    };
  }

  private buildService(k8sNamespace: string): k8s.V1Service {
    const config = getConfig();
    const chromiumPort = config.services.chromium.port;

    return {
      metadata: {
        name: 'chromium',
        namespace: k8sNamespace,
      },
      spec: {
        selector: {
          app: 'chromium',
        },
        ports: [
          {
            port: 80,
            targetPort: chromiumPort,
            name: 'http',
          },
          {
            port: chromiumPort,
            targetPort: chromiumPort,
            name: 'cdp',
          },
        ],
      },
    };
  }
}
