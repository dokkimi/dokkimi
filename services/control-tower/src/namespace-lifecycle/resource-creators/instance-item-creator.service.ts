import { Injectable, Logger } from '@nestjs/common';
import { KubernetesResourceService } from '../kubernetes/kubernetes-resource.service';
import { ServiceDeploymentBuilderService } from '../builders/service-deployment-builder.service';
import { DatabaseDeploymentBuilderService } from '../builders/database-deployment-builder.service';
import { DatabaseConfigService } from '../builders/database-config.service';
import { DefinitionItem } from '../../namespace-deployer/deployment-context.types';

// Extended interface with k8sName required for deployment
export interface DeployableItem extends DefinitionItem {
  k8sName: string;
}

@Injectable()
export class InstanceItemCreatorService {
  private readonly logger = new Logger(InstanceItemCreatorService.name);

  constructor(
    private readonly k8sResource: KubernetesResourceService,
    private readonly serviceDeploymentBuilder: ServiceDeploymentBuilderService,
    private readonly databaseDeploymentBuilder: DatabaseDeploymentBuilderService,
    private readonly databaseConfig: DatabaseConfigService,
  ) {}

  async createService(
    namespace: string,
    instanceId: string,
    item: DeployableItem,
    k8sDnsIP: string,
    instanceItemId?: string,
    interceptorClusterIP?: string,
    allServiceNames?: string[],
    databaseNames?: string[],
  ): Promise<void> {
    if (!item.image) {
      this.logger.warn(`Skipping service ${item.name} - no image specified`);
      return;
    }

    try {
      // Create per-service dnsmasq ConfigMap FIRST (deployment references it in volume mounts)
      if (interceptorClusterIP && allServiceNames) {
        const dnsmasqConfigMap =
          this.serviceDeploymentBuilder.buildDnsmasqConfigMapForService(
            item.k8sName,
            namespace,
            allServiceNames,
            interceptorClusterIP,
            k8sDnsIP,
            databaseNames,
          );
        await this.k8sResource.createOrUpdateConfigMap(
          namespace,
          dnsmasqConfigMap,
        );
        this.logger.log(
          `Created dnsmasq ConfigMap for service ${item.name} with interceptor ClusterIP ${interceptorClusterIP}`,
        );
      }

      const deployment = this.serviceDeploymentBuilder.buildServiceDeployment(
        item,
        namespace,
        instanceId,
        k8sDnsIP,
        instanceItemId,
      );
      const k8sService = this.serviceDeploymentBuilder.buildService(
        item,
        namespace,
      );

      await this.k8sResource.createDeployment(namespace, deployment);
      await this.k8sResource.createService(namespace, k8sService);

      this.logger.log(
        `Created service ${item.name} for namespace ${namespace}`,
      );
    } catch (err) {
      this.logger.error(`Failed to create service ${item.name}:`, err);
      throw err;
    }
  }

  async createDatabase(
    namespace: string,
    instanceId: string,
    item: DeployableItem,
    instanceItemId: string,
  ): Promise<void> {
    if (!item.database) {
      this.logger.warn(
        `Skipping database ${item.name} - no database type specified`,
      );
      return;
    }

    try {
      const dbConfig = this.databaseConfig.getConfig(
        item.database,
        {
          dbName: item.dbName ?? undefined,
          dbUser: item.dbUser ?? undefined,
          dbPassword: item.dbPassword ?? undefined,
        },
        item.version ?? undefined,
      );
      const deployment = this.databaseDeploymentBuilder.buildDatabaseDeployment(
        item,
        namespace,
        instanceId,
        instanceItemId,
        dbConfig,
      );
      const k8sService = this.databaseDeploymentBuilder.buildDatabaseService(
        item,
        namespace,
        dbConfig.ports,
      );

      await this.k8sResource.createDeployment(namespace, deployment);
      await this.k8sResource.createService(namespace, k8sService);

      this.logger.log(
        `Created database ${item.name} (${item.database}) for namespace ${namespace}`,
      );
    } catch (err) {
      this.logger.error(`Failed to create database ${item.name}:`, err);
      throw err;
    }
  }
}
