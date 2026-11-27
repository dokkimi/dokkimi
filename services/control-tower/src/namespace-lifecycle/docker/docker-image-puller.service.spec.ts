import { DockerImagePullerService } from './docker-image-puller.service';
import { BrokerConfigService } from '../builders/broker-config.service';
import { DeploymentContext } from '../deployment-context.types';

jest.mock('dockerode', () => jest.fn(() => ({})));

jest.mock('@dokkimi/config', () => ({
  getConfig: () => ({
    images: { brokers: { amqp: 'rabbitmq:3', kafka: 'apache/kafka:3.9' } },
  }),
}));

describe('DockerImagePullerService', () => {
  const pullImage = jest.fn().mockResolvedValue(undefined);
  const auth = { username: 'u', password: 'p', serveraddress: 'ghcr.io' };
  const service = new DockerImagePullerService(
    { pullImage } as never,
    { getConfig: () => ({ image: 'postgres:15' }) } as never,
    { getDbProxyImage: () => 'db-proxy' } as never,
    new BrokerConfigService(),
    { getBrokerProxyImage: () => 'broker-proxy' } as never,
    {
      getAuthConfig: (_runId: string, image: string) =>
        image.startsWith('ghcr.io/') ? auth : undefined,
    } as never,
  );

  const pulled = async (items: object[]) => {
    pullImage.mockClear();
    await service.pullAllImages(
      { runId: 'run', definition: { items } } as unknown as DeploymentContext,
      false,
    );
    return pullImage.mock.calls;
  };

  // Before, the engine's default image was pulled and the custom one run,
  // which failed with "No such image" where it wasn't already present
  it('pulls the custom image of a database or broker, with credentials', async () => {
    const calls = await pulled([
      {
        type: 'DATABASE',
        name: 'db',
        database: 'postgres',
        image: 'ghcr.io/acme/postgres-partman:15',
      },
      {
        type: 'BROKER',
        name: 'mq',
        broker: 'amqp',
        image: 'rabbitmq:3.13-management',
      },
    ]);

    expect(calls).toContainEqual(['ghcr.io/acme/postgres-partman:15', auth]);
    expect(calls).toContainEqual(['rabbitmq:3.13-management', undefined]);
    const images = calls.map(([image]) => image);
    expect(images).not.toContain('postgres:15');
    expect(images).not.toContain('rabbitmq:3');
  });

  it('pulls the default image without a custom one, once', async () => {
    const calls = await pulled([
      { type: 'DATABASE', name: 'a', database: 'postgres' },
      { type: 'DATABASE', name: 'b', database: 'postgres' },
      { type: 'BROKER', name: 'mq', broker: 'kafka' },
    ]);
    const images = calls.map(([image]) => image);

    expect(images.filter((i) => i === 'postgres:15')).toHaveLength(1);
    expect(images).toContain('apache/kafka:3.9');
  });
});
