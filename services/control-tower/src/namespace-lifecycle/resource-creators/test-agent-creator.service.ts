import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { KubernetesResourceService } from '../kubernetes/kubernetes-resource.service';
import { getConfig, buildTestAgentEnvVars } from '@dokkimi/config';
import { DOKKIMI_IMAGES } from '../../constants/image-tags';

export interface TestAgentCreateOptions {
  hasUiSteps?: boolean;
}

@Injectable()
export class TestAgentCreatorService {
  private readonly logger = new Logger(TestAgentCreatorService.name);

  constructor(private readonly k8sResource: KubernetesResourceService) {}

  async create(
    k8sNamespace: string,
    instanceId: string,
    options: TestAgentCreateOptions = {},
  ): Promise<void> {
    // Create RBAC resources first
    const serviceAccount = this.buildServiceAccount(k8sNamespace);
    const role = this.buildRole(k8sNamespace);
    const roleBinding = this.buildRoleBinding(k8sNamespace);

    await this.k8sResource.createServiceAccount(k8sNamespace, serviceAccount);
    await this.k8sResource.createRole(k8sNamespace, role);
    await this.k8sResource.createRoleBinding(k8sNamespace, roleBinding);

    const deployment = this.buildDeployment(k8sNamespace, instanceId, options);
    const service = this.buildService(k8sNamespace);

    await this.k8sResource.createDeployment(k8sNamespace, deployment);
    await this.k8sResource.createService(k8sNamespace, service);

    this.logger.log(
      `Created test-agent for instance ${instanceId} in namespace ${k8sNamespace}`,
    );
  }

  private buildServiceAccount(k8sNamespace: string): k8s.V1ServiceAccount {
    return {
      metadata: {
        name: 'test-agent-service-account',
        namespace: k8sNamespace,
      },
    };
  }

  private buildRole(k8sNamespace: string): k8s.V1Role {
    return {
      metadata: {
        name: 'test-agent-configmap-reader',
        namespace: k8sNamespace,
      },
      rules: [
        {
          apiGroups: [''],
          resources: ['configmaps'],
          verbs: ['get', 'list', 'watch'],
          resourceNames: ['dokkimi-interceptor-config'],
        },
        {
          apiGroups: [''],
          resources: ['pods'],
          verbs: ['list', 'get'],
        },
        {
          apiGroups: [''],
          resources: ['services'],
          verbs: ['list'],
        },
      ],
    };
  }

  private buildRoleBinding(k8sNamespace: string): k8s.V1RoleBinding {
    return {
      metadata: {
        name: 'test-agent-configmap-reader-binding',
        namespace: k8sNamespace,
      },
      subjects: [
        {
          kind: 'ServiceAccount',
          name: 'test-agent-service-account',
          namespace: k8sNamespace,
        },
      ],
      roleRef: {
        kind: 'Role',
        name: 'test-agent-configmap-reader',
        apiGroup: 'rbac.authorization.k8s.io',
      },
    };
  }

  private buildDeployment(
    k8sNamespace: string,
    instanceId: string,
    options: TestAgentCreateOptions,
  ): k8s.V1Deployment {
    const config = getConfig();
    const { hasUiSteps = false } = options;

    const envVars = buildTestAgentEnvVars(config, {
      k8sNamespace: k8sNamespace,
      browserURL: hasUiSteps
        ? `http://chromium:${config.services.chromium.port}`
        : undefined,
      defaultViewportWidth: config.browser?.defaultViewportWidth,
      defaultViewportHeight: config.browser?.defaultViewportHeight,
    });

    return {
      metadata: {
        name: 'test-agent',
        namespace: k8sNamespace,
        labels: {
          app: 'test-agent',
        },
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: {
            app: 'test-agent',
          },
        },
        template: {
          metadata: {
            labels: {
              app: 'test-agent',
              'dokkimi.io/instance-id': instanceId,
            },
          },
          spec: {
            terminationGracePeriodSeconds: 1,
            serviceAccountName: 'test-agent-service-account',
            containers: [
              {
                name: 'test-agent',
                image: DOKKIMI_IMAGES.testAgent,
                imagePullPolicy: 'IfNotPresent',
                ports: [{ containerPort: config.services.testAgent.port }],
                env: envVars,
                resources: {
                  requests: {
                    cpu: '100m',
                    memory: '128Mi',
                  },
                  limits: {
                    cpu: '500m',
                    memory: '256Mi',
                  },
                },
              },
            ],
          },
        },
      },
    };
  }

  private buildService(k8sNamespace: string): k8s.V1Service {
    const config = getConfig();
    const port = config.services.testAgent.port;

    return {
      metadata: {
        name: 'test-agent-service',
        namespace: k8sNamespace,
      },
      spec: {
        selector: {
          app: 'test-agent',
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
