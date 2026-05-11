import { Module } from '@nestjs/common';
import { NamespaceLifecycleModule } from '../namespace-lifecycle/namespace-lifecycle.module';
import { NamespaceModule } from '../namespace/namespace.module';
import { NamespaceDeployerService } from './namespace-deployer.service';
import { DeployerConfigMapService } from './deployer-configmap.service';

@Module({
  imports: [
    NamespaceLifecycleModule, // K8s client, resource creators, configmap builder
    NamespaceModule, // InstanceItemService, NamespaceInstanceService
  ],
  providers: [NamespaceDeployerService, DeployerConfigMapService],
  exports: [NamespaceDeployerService],
})
export class NamespaceDeployerModule {}
