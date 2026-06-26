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

    const effectiveInternalPort = item.port || brokerCfg.internalPort;

    const brokerProxyEnvEntries = buildBrokerProxyEnvVars(config, {
      brokerType: item.broker,
      brokerPort: String(effectiveInternalPort),
      proxyPort: String(brokerCfg.nativePort),
      instanceItemName: item.name,
      namespace: instanceId,
      namespaceItemId: instanceItemId,
      testAgentUrl: `http://test-agent-service:${config.services.testAgent.port}`,
      healthCheckEndpoint: item.healthCheck || undefined,
    });
    const brokerProxyEnv = envArrayToRecord(brokerProxyEnvEntries);

    const brokerEnv: Record<string, string> = { ...brokerCfg.environment };
    // Tell RabbitMQ to listen on the internal port
    if (item.broker.toLowerCase() === 'amqp') {
      brokerEnv.RABBITMQ_NODE_PORT = String(effectiveInternalPort);
    }
    // Kafka: configure listeners on internal port, advertise via proxy port
    if (item.broker.toLowerCase() === 'kafka') {
      brokerEnv.KAFKA_LISTENERS = `PLAINTEXT://0.0.0.0:${effectiveInternalPort},CONTROLLER://localhost:9093`;
      brokerEnv.KAFKA_ADVERTISED_LISTENERS = `PLAINTEXT://${containerName}:${brokerCfg.nativePort}`;
    }

    if (item.env) {
      if (Array.isArray(item.env)) {
        for (const e of item.env as Array<{ name: string; value: string }>) {
          brokerEnv[e.name] = e.value;
        }
      } else {
        for (const [k, v] of Object.entries(item.env)) {
          brokerEnv[k] = v;
        }
      }
    }

    const brokerImage = item.image || brokerCfg.image;

    await this.dockerClient.runContainer({
      name: brokerProxyName,
      image: brokerProxyImage,
      networkName,
      networkAliases: [containerName],
      env: brokerProxyEnv,
      exposedPorts: [brokerCfg.nativePort, effectiveInternalPort],
      labels: {
        'io.dokkimi.instance-id': instanceId,
        'io.dokkimi.role': 'broker-proxy',
        'io.dokkimi.item-name': item.name,
      },
    });

    await this.dockerClient.runContainer({
      name: brokerContainerName,
      image: brokerImage,
      networkName,
      networkMode: `container:${brokerProxyName}`,
      env: brokerEnv,
      exposedPorts: [effectiveInternalPort],
      labels: {
        'io.dokkimi.instance-id': instanceId,
        'io.dokkimi.role': 'broker',
        'io.dokkimi.item-name': item.name,
      },
      ...(item.command ? { cmd: item.command } : {}),
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
