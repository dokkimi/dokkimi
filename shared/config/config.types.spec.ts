import { buildServiceUrl, buildClusterServiceUrl } from './config.types';

const service = (host: string) => ({
  protocol: 'http' as const,
  host,
  port: 19001,
});

describe('buildServiceUrl', () => {
  it('returns the host as-is', () => {
    expect(buildServiceUrl(service('localhost'))).toBe(
      'http://localhost:19001',
    );
  });

  it('preserves 0.0.0.0', () => {
    expect(buildServiceUrl(service('0.0.0.0'))).toBe('http://0.0.0.0:19001');
  });

  it('preserves a real hostname', () => {
    expect(buildServiceUrl(service('ct.internal'))).toBe(
      'http://ct.internal:19001',
    );
  });
});

describe('buildClusterServiceUrl', () => {
  it('maps localhost to host.docker.internal', () => {
    expect(buildClusterServiceUrl(service('localhost'))).toBe(
      'http://host.docker.internal:19001',
    );
  });

  it('maps 127.0.0.1 to host.docker.internal', () => {
    expect(buildClusterServiceUrl(service('127.0.0.1'))).toBe(
      'http://host.docker.internal:19001',
    );
  });

  it('maps 0.0.0.0 to host.docker.internal', () => {
    expect(buildClusterServiceUrl(service('0.0.0.0'))).toBe(
      'http://host.docker.internal:19001',
    );
  });

  it('passes through a real hostname', () => {
    expect(buildClusterServiceUrl(service('ct.internal'))).toBe(
      'http://ct.internal:19001',
    );
  });
});
