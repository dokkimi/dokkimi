import { Injectable } from '@nestjs/common';

export interface BrokerConfig {
  image: string;
  environment: Record<string, string>;
  nativePort: number;
  internalPort: number;
}

@Injectable()
export class BrokerConfigService {
  getConfig(brokerType: string, version?: string): BrokerConfig {
    const configs: Record<string, BrokerConfig> = {
      amqp: {
        image: `rabbitmq:${version || '3'}`,
        environment: {},
        nativePort: 5672,
        internalPort: 35672, // RABBITMQ_NODE_PORT; must be ≤ 45535 (Erlang dist = port + 20000)
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
