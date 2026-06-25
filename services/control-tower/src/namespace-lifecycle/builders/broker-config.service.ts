import { Injectable } from '@nestjs/common';
import { getConfig } from '@dokkimi/config';

export interface BrokerConfig {
  image: string;
  environment: Record<string, string>;
  nativePort: number;
  internalPort: number;
}

@Injectable()
export class BrokerConfigService {
  getConfig(brokerType: string, version?: string): BrokerConfig {
    const imgs = getConfig().images.brokers;

    const configs: Record<string, BrokerConfig> = {
      amqp: {
        image: version ? `rabbitmq:${version}` : imgs.amqp,
        environment: {},
        nativePort: 5672,
        internalPort: 35672, // RABBITMQ_NODE_PORT; must be ≤ 45535 (Erlang dist = port + 20000)
      },
      kafka: {
        image: version ? `apache/kafka:${version}` : imgs.kafka,
        environment: {
          KAFKA_NODE_ID: '1',
          KAFKA_PROCESS_ROLES: 'broker,controller',
          KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
          KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
          KAFKA_LISTENER_SECURITY_PROTOCOL_MAP:
            'PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT',
          KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
          KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
          KAFKA_LOG_DIRS: '/tmp/kraft-combined-logs',
        },
        nativePort: 9092,
        internalPort: 39092,
      },
    };

    return (
      configs[brokerType.toLowerCase()] || {
        image: `${brokerType}:${version || 'latest'}`,
        environment: {},
        nativePort: 5672,
        internalPort: 55672,
      }
    );
  }
}
