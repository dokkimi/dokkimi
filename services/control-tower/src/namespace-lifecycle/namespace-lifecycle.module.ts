import { Module, forwardRef } from '@nestjs/common';
import { NamespaceLifecycleService } from './namespace-lifecycle.service';
import { PrismaModule } from '../prisma/prisma.module';
import { DockerClientService } from './docker/docker-client.service';
import { DockerConfigService } from './docker/docker-config.service';
import { DockerCaService } from './docker/docker-ca.service';
import { DockerRegistryService } from './docker/docker-registry.service';
import { DockerDeployerService } from './docker/docker-deployer.service';
import { DockerLogCollectorService } from './docker/docker-log-collector.service';
import { DockerServiceGroupService } from './docker/docker-service-group.service';
import { DockerDatabaseGroupService } from './docker/docker-database-group.service';
import { DockerBrokerGroupService } from './docker/docker-broker-group.service';
import { DockerDeployConfigService } from './docker/docker-deploy-config.service';
import { DockerImagePullerService } from './docker/docker-image-puller.service';
import { DatabaseConfigService } from './builders/database-config.service';
import { BrokerConfigService } from './builders/broker-config.service';
import { ConfigMapBuilderService } from './builders/configmap-builder.service';
import { NamespaceModule } from '../namespace/namespace.module';
import { LogProcessingModule } from '../log-processing/log-processing.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => NamespaceModule),
    LogProcessingModule,
    StorageModule,
  ],
  providers: [
    NamespaceLifecycleService,
    DockerClientService,
    DockerConfigService,
    DockerCaService,
    DockerRegistryService,
    DockerDeployerService,
    DockerLogCollectorService,
    DockerServiceGroupService,
    DockerDatabaseGroupService,
    DockerBrokerGroupService,
    DockerDeployConfigService,
    DockerImagePullerService,
    DatabaseConfigService,
    BrokerConfigService,
    ConfigMapBuilderService,
  ],
  exports: [
    NamespaceLifecycleService,
    DockerClientService,
    DockerConfigService,
    DockerCaService,
    DockerRegistryService,
    DockerDeployerService,
    DockerLogCollectorService,
    ConfigMapBuilderService,
  ],
})
export class NamespaceLifecycleModule {}
