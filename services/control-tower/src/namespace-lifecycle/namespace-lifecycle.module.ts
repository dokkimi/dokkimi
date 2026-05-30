import { Module, forwardRef } from '@nestjs/common';
import { NamespaceLifecycleService } from './namespace-lifecycle.service';
import { PrismaModule } from '../prisma/prisma.module';
import { KubernetesClientService } from './kubernetes/kubernetes-client.service';
import { KubernetesResourceService } from './kubernetes/kubernetes-resource.service';
import { DockerClientService } from './docker/docker-client.service';
import { DockerConfigService } from './docker/docker-config.service';
import { DockerCaService } from './docker/docker-ca.service';
import { DockerRegistryService } from './docker/docker-registry.service';
import { ServiceDeploymentBuilderService } from './builders/service-deployment-builder.service';
import { DatabaseDeploymentBuilderService } from './builders/database-deployment-builder.service';
import { DatabaseConfigService } from './builders/database-config.service';
import { ConfigMapBuilderService } from './builders/configmap-builder.service';
import { InterceptorCreatorService } from './resource-creators/interceptor-creator.service';
import { ServiceInterceptorCreatorService } from './resource-creators/service-interceptor-creator.service';
import { TestAgentCreatorService } from './resource-creators/test-agent-creator.service';
import { ChromiumCreatorService } from './resource-creators/chromium-creator.service';
import { InstanceItemCreatorService } from './resource-creators/instance-item-creator.service';
import { NamespaceModule } from '../namespace/namespace.module';
import { DokkimiCaService } from './dokkimi-ca.service';
import { RegistryCredentialsService } from './registry-credentials.service';

@Module({
  imports: [PrismaModule, forwardRef(() => NamespaceModule)],
  providers: [
    NamespaceLifecycleService,
    KubernetesClientService,
    KubernetesResourceService,
    DockerClientService,
    DockerConfigService,
    DockerCaService,
    DockerRegistryService,
    ServiceDeploymentBuilderService,
    DatabaseDeploymentBuilderService,
    DatabaseConfigService,
    ConfigMapBuilderService,
    InterceptorCreatorService,
    ServiceInterceptorCreatorService,
    TestAgentCreatorService,
    ChromiumCreatorService,
    InstanceItemCreatorService,
    DokkimiCaService,
    RegistryCredentialsService,
  ],
  exports: [
    NamespaceLifecycleService,
    KubernetesClientService,
    KubernetesResourceService,
    DockerClientService,
    DockerConfigService,
    DockerCaService,
    DockerRegistryService,
    ConfigMapBuilderService,
    InterceptorCreatorService,
    ServiceInterceptorCreatorService,
    TestAgentCreatorService,
    ChromiumCreatorService,
    InstanceItemCreatorService,
    DokkimiCaService,
    RegistryCredentialsService,
  ],
})
export class NamespaceLifecycleModule {}
