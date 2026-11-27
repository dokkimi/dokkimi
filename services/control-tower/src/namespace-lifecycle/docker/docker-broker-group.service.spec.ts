import { DockerBrokerGroupService } from './docker-broker-group.service';
import { BrokerConfigService } from '../builders/broker-config.service';
import { DefinitionItem } from '../deployment-context.types';

jest.mock('dockerode', () => jest.fn(() => ({})));

jest.mock('@dokkimi/config', () => ({
  getConfig: () => ({
    services: { testAgent: { port: 8080 } },
    images: { brokers: { amqp: 'rabbitmq:3', kafka: 'apache/kafka:3.9' } },
  }),
  buildBrokerProxyEnvVars: (
    _cfg: unknown,
    o: { proxyPort: string; brokerPort: string },
  ) => [
    { name: 'PROXY_PORT', value: o.proxyPort },
    { name: 'BROKER_PORT', value: o.brokerPort },
  ],
}));

describe('DockerBrokerGroupService ports', () => {
  const runContainer = jest.fn().mockResolvedValue('id');
  const service = new DockerBrokerGroupService(
    { runContainer } as never,
    new BrokerConfigService(),
  );

  beforeEach(() => runContainer.mockClear());

  const deploy = async (item: Partial<DefinitionItem>) => {
    await service.createBrokerGroup(
      'net',
      'inst',
      { type: 'BROKER', name: 'mq', ...item } as DefinitionItem,
      'mq',
      'item-1',
    );
    const [proxy, broker] = runContainer.mock.calls.map(([o]) => o);
    return { proxy, broker };
  };

  // Before, `port` moved the broker: with the native port the proxy dialled
  // itself, and with another port clients bypassed the proxy
  it.each([
    ['amqp', undefined, '5672'],
    ['amqp', 5672, '5672'],
    ['amqp', 5673, '5673'],
    ['kafka', undefined, '9092'],
    ['kafka', 29092, '29092'],
  ])(
    '%s with port %s: the proxy listens on %s, the broker stays internal',
    async (broker, port, listen) => {
      const { proxy, broker: b } = await deploy({ broker, port });
      const internal = broker === 'amqp' ? '10672' : '19092';

      expect(proxy.env.PROXY_PORT).toBe(listen);
      expect(proxy.env.BROKER_PORT).toBe(internal);
      expect(proxy.exposedPorts).toEqual([Number(listen), Number(internal)]);
      expect(b.exposedPorts).toEqual([Number(internal)]);
      if (broker === 'amqp') {
        expect(b.env.RABBITMQ_NODE_PORT).toBe(internal);
      } else {
        expect(b.env.KAFKA_LISTENERS).toContain(`0.0.0.0:${internal},`);
        // Clients are told to reconnect through the proxy
        expect(b.env.KAFKA_ADVERTISED_LISTENERS).toBe(
          `PLAINTEXT://mq:${listen}`,
        );
      }
    },
  );
});
