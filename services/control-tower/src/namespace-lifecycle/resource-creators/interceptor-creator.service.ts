import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { KubernetesResourceService } from '../kubernetes/kubernetes-resource.service';
import { getConfig, buildInterceptorEnvVars } from '@dokkimi/config';
import { DOKKIMI_IMAGES } from '../../constants/image-tags';

@Injectable()
export class InterceptorCreatorService {
  private readonly logger = new Logger(InterceptorCreatorService.name);

  constructor(private readonly k8sResource: KubernetesResourceService) {}

  async create(
    k8sNamespace: string,
    instanceId: string,
    k8sDnsIP: string,
  ): Promise<void> {
    // Create RBAC resources first
    const serviceAccount = this.buildServiceAccount(k8sNamespace);
    const role = this.buildRole(k8sNamespace);
    const roleBinding = this.buildRoleBinding(k8sNamespace);

    await this.k8sResource.createServiceAccount(k8sNamespace, serviceAccount);
    await this.k8sResource.createRole(k8sNamespace, role);
    await this.k8sResource.createRoleBinding(k8sNamespace, roleBinding);

    const deployment = this.buildDeployment(k8sNamespace, instanceId, k8sDnsIP);
    const service = this.buildService(k8sNamespace);

    await this.k8sResource.createDeployment(k8sNamespace, deployment);
    await this.k8sResource.createService(k8sNamespace, service);

    // Note: No ingress needed - desktop app connects directly via kubectl port-forward

    this.logger.log(
      `Created interceptor for instance ${instanceId} in namespace ${k8sNamespace}`,
    );
  }

  private buildServiceAccount(k8sNamespace: string): k8s.V1ServiceAccount {
    return {
      metadata: {
        name: 'interceptor-service-account',
        namespace: k8sNamespace,
      },
    };
  }

  private buildRole(k8sNamespace: string): k8s.V1Role {
    return {
      metadata: {
        name: 'interceptor-configmap-reader',
        namespace: k8sNamespace,
      },
      rules: [
        {
          apiGroups: [''],
          resources: ['configmaps'],
          verbs: ['get', 'list', 'watch'],
          resourceNames: ['dokkimi-interceptor-config'],
        },
      ],
    };
  }

  private buildRoleBinding(k8sNamespace: string): k8s.V1RoleBinding {
    return {
      metadata: {
        name: 'interceptor-configmap-reader-binding',
        namespace: k8sNamespace,
      },
      subjects: [
        {
          kind: 'ServiceAccount',
          name: 'interceptor-service-account',
          namespace: k8sNamespace,
        },
      ],
      roleRef: {
        kind: 'Role',
        name: 'interceptor-configmap-reader',
        apiGroup: 'rbac.authorization.k8s.io',
      },
    };
  }

  private buildDeployment(
    k8sNamespace: string,
    instanceId: string,
    k8sDnsIP: string,
  ): k8s.V1Deployment {
    const config = getConfig();

    // Build type-safe environment variables for the shared interceptor
    // Empty ORIGIN indicates this is the shared interceptor for external traffic
    const envVars = buildInterceptorEnvVars(config, {
      namespace: instanceId,
      k8sNamespace: k8sNamespace,
      apiKey: 'dokkimi-interceptor-key', // Default API key for internal service communication
      k8sDnsIP,
      origin: '', // Empty for shared interceptor
    });

    return {
      metadata: {
        name: 'interceptor',
        namespace: k8sNamespace,
        labels: {
          app: 'interceptor',
        },
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: {
            app: 'interceptor',
          },
        },
        template: {
          metadata: {
            labels: {
              app: 'interceptor',
              'dokkimi.io/instance-id': instanceId,
            },
          },
          spec: {
            terminationGracePeriodSeconds: 1,
            serviceAccountName: 'interceptor-service-account',
            containers: [
              {
                name: 'interceptor',
                image: DOKKIMI_IMAGES.interceptor,
                imagePullPolicy: 'IfNotPresent',
                ports: [{ containerPort: config.services.interceptor.port }],
                env: envVars,
              },
            ],
          },
        },
      },
    };
  }

  private buildService(k8sNamespace: string): k8s.V1Service {
    const config = getConfig();
    const port = config.services.interceptor.port;

    return {
      metadata: {
        name: 'interceptor-service',
        namespace: k8sNamespace,
      },
      spec: {
        selector: {
          app: 'interceptor',
        },
        ports: [
          {
            port: port,
            targetPort: port,
          },
        ],
      },
    };
  }
}
