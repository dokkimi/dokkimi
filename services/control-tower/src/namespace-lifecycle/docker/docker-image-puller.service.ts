import { Injectable, Logger } from '@nestjs/common';
import { DockerClientService } from './docker-client.service';
import { DockerDatabaseGroupService } from './docker-database-group.service';
import { DockerBrokerGroupService } from './docker-broker-group.service';
import { DockerRegistryService } from './docker-registry.service';
import { DatabaseConfigService } from '../builders/database-config.service';
import { BrokerConfigService } from '../builders/broker-config.service';
import {
  DOKKIMI_IMAGES,
  resolveBrowserImage,
} from '../../constants/image-tags';
import { DeploymentContext } from '../deployment-context.types';

@Injectable()
export class DockerImagePullerService {
  private readonly logger = new Logger(DockerImagePullerService.name);

  constructor(
    private readonly dockerClient: DockerClientService,
    private readonly databaseConfig: DatabaseConfigService,
    private readonly databaseGroup: DockerDatabaseGroupService,
    private readonly brokerConfig: BrokerConfigService,
    private readonly brokerGroup: DockerBrokerGroupService,
    private readonly registryService: DockerRegistryService,
  ) {}

  async pullAllImages(
    ctx: DeploymentContext,
    attachChromium: boolean,
  ): Promise<void> {
    const pulls: Array<Promise<void>> = [];

    const infraImages = new Set<string>([
      DOKKIMI_IMAGES.interceptor,
      DOKKIMI_IMAGES.testAgent,
      DOKKIMI_IMAGES.dnsmasq,
    ]);

    for (const item of ctx.definition.items) {
      if (item.type === 'DATABASE' && item.database) {
        infraImages.add(this.databaseGroup.getDbProxyImage(item.database));
      }
      if (item.type === 'BROKER' && item.broker) {
        infraImages.add(this.brokerGroup.getBrokerProxyImage(item.broker));
      }
    }

    if (attachChromium) {
      infraImages.add(resolveBrowserImage(ctx.definition.config?.browser));
    }

    for (const image of infraImages) {
      pulls.push(this.dockerClient.pullImage(image));
    }

    for (const item of ctx.definition.items) {
      if ((item.type === 'SERVICE' || item.type === 'WORKER') && item.image) {
        const auth = this.registryService.getAuthConfig(ctx.runId, item.image);
        pulls.push(this.dockerClient.pullImage(item.image, auth));
      }
    }

    const dbImages = new Set<string>();
    for (const item of ctx.definition.items) {
      if (item.type !== 'DATABASE' || !item.database) {
        continue;
      }
      const dbConfig = this.databaseConfig.getConfig(
        item.database,
        {
          dbName: item.dbName ?? undefined,
          dbUser: item.dbUser ?? undefined,
          dbPassword: item.dbPassword ?? undefined,
        },
        item.version ?? undefined,
      );
      if (!dbImages.has(dbConfig.image)) {
        dbImages.add(dbConfig.image);
        pulls.push(this.dockerClient.pullImage(dbConfig.image));
      }
    }

    const brokerImages = new Set<string>();
    for (const item of ctx.definition.items) {
      if (item.type !== 'BROKER' || !item.broker) {
        continue;
      }
      const bCfg = this.brokerConfig.getConfig(
        item.broker,
        item.version ?? undefined,
      );
      if (!brokerImages.has(bCfg.image)) {
        brokerImages.add(bCfg.image);
        pulls.push(this.dockerClient.pullImage(bCfg.image));
      }
    }

    await Promise.all(pulls);
  }
}
