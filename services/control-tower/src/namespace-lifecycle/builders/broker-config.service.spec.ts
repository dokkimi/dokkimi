import { BrokerConfigService } from './broker-config.service';

jest.mock('@dokkimi/config', () => ({
  getConfig: () => ({
    images: { brokers: { amqp: 'rabbitmq', kafka: 'kafka' } },
  }),
}));

describe('BrokerConfigService', () => {
  it('keeps internal ports outside the ephemeral range', () => {
    const service = new BrokerConfigService();
    const amqp = service.getConfig('amqp').internalPort;
    const kafka = service.getConfig('kafka').internalPort;

    // Erlang also listens on the AMQP port + 20000
    for (const port of [amqp, amqp + 20000, kafka]) {
      expect(port < 32768 || port > 60999).toBe(true);
    }
  });
});
