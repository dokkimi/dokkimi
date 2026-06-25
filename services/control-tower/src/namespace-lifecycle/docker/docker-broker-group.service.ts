import { Injectable, Logger } from '@nestjs/common';
import { getConfig, buildBrokerProxyEnvVars } from '@dokkimi/config';
import { DockerClientService } from './docker-client.service';
import { DOKKIMI_IMAGES } from '../../constants/image-tags';
import { DefinitionItem } from '../deployment-context.types';
import { BrokerConfigService } from '../builders/broker-config.service';
import { envArrayToRecord } from './env.utils';

@Injectable()
export class DockerBrokerGroupService {
  private readonly logger = new Logger(DockerBrokerGroupService.name);

  constructor(
    private readonly dockerClient: DockerClientService,
    private readonly brokerConfig: BrokerConfigService,
  ) {}

  async createBrokerGroup(
    networkName: string,
    instanceId: string,
    item: DefinitionItem,
    containerName: string,
    instanceItemId: string,
  ): Promise<void> {
    if (!item.broker) {
      this.logger.warn(`Skipping broker ${item.name} — no broker type`);
      return;
    }

    const config = getConfig();
    const brokerCfg = this.brokerConfig.getConfig(
      item.broker,
      item.version ?? undefined,
    );

    const brokerProxyImage = this.getBrokerProxyImage(item.broker);

    const brokerProxyName = `${containerName}-brokerproxy-${instanceId}`;
    const brokerContainerName = `${containerName}-broker-${instanceId}`;

    const brokerProxyEnvEntries = buildBrokerProxyEnvVars(config, {
      brokerType: item.broker,
      brokerPort: String(brokerCfg.internalPort),
      proxyPort: String(brokerCfg.nativePort),
      instanceItemName: item.name,
      namespace: instanceId,
      namespaceItemId: instanceItemId,
      testAgentUrl: `http://test-agent-service:${config.services.testAgent.port}`,
    });
    const brokerProxyEnv = envArrayToRecord(brokerProxyEnvEntries);

    const brokerEnv: Record<string, string> = { ...brokerCfg.environment };
    // Tell RabbitMQ to listen on the internal port
    if (item.broker.toLowerCase() === 'amqp') {
      brokerEnv.RABBITMQ_NODE_PORT = String(brokerCfg.internalPort);
    }
    // Kafka: configure listeners on internal port, advertise via proxy port
    if (item.broker.toLowerCase() === 'kafka') {
      brokerEnv.KAFKA_LISTENERS = `PLAINTEXT://0.0.0.0:${brokerCfg.internalPort},CONTROLLER://localhost:9093`;
      brokerEnv.KAFKA_ADVERTISED_LISTENERS = `PLAINTEXT://${containerName}:${brokerCfg.nativePort}`;
    }

    await this.dockerClient.runContainer({
      name: brokerProxyName,
      image: brokerProxyImage,
      networkName,
      networkAliases: [containerName],
      env: brokerProxyEnv,
      exposedPorts: [brokerCfg.nativePort, brokerCfg.internalPort],
      labels: {
        'io.dokkimi.instance-id': instanceId,
        'io.dokkimi.role': 'broker-proxy',
        'io.dokkimi.item-name': item.name,
      },
    });

    await this.dockerClient.runContainer({
      name: brokerContainerName,
      image: brokerCfg.image,
      networkName,
      networkMode: `container:${brokerProxyName}`,
      env: brokerEnv,
      exposedPorts: [brokerCfg.internalPort],
      labels: {
        'io.dokkimi.instance-id': instanceId,
        'io.dokkimi.role': 'broker',
        'io.dokkimi.item-name': item.name,
      },
    });

    this.logger.log(`Created broker group for ${item.name} (${item.broker})`);
  }

  getBrokerProxyImage(brokerType: string): string {
    switch (brokerType.toLowerCase()) {
      case 'amqp':
        return DOKKIMI_IMAGES.brokerProxyAmqp;
      case 'kafka':
        return DOKKIMI_IMAGES.brokerProxyKafka;
      default:
        throw new Error(`Unsupported broker type: ${brokerType}`);
    }
  }
}
