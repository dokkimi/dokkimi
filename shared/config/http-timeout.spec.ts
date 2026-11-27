import * as path from 'path';
import { buildTestAgentEnvVars } from './go-service-env.builder';

const configPath = path.join(__dirname, '../../config/config.yaml');

function testAgentTimeout(value?: string): string | undefined {
  delete process.env.DOKKIMI_HTTP_TIMEOUT;
  if (value !== undefined) {
    process.env.DOKKIMI_HTTP_TIMEOUT = value;
  }
  let timeout: string | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ConfigLoader } = require('./config.loader');
    timeout = buildTestAgentEnvVars(
      ConfigLoader.getInstance().load(configPath),
      { namespace: 'ns' },
    ).find((e) => e.name === 'HTTP_TIMEOUT_MS')?.value;
  });
  return timeout;
}

describe('HTTP timeout', () => {
  const original = process.env.DOKKIMI_HTTP_TIMEOUT;

  afterAll(() => {
    delete process.env.DOKKIMI_HTTP_TIMEOUT;
    if (original !== undefined) {
      process.env.DOKKIMI_HTTP_TIMEOUT = original;
    }
  });

  it('is 30 seconds by default', () => {
    expect(testAgentTimeout()).toBe('30000');
  });

  it('reaches the test-agent from DOKKIMI_HTTP_TIMEOUT', () => {
    expect(testAgentTimeout('60000')).toBe('60000');
  });

  it.each(['abc', '0', '-1', '1.5', '1e999'])('rejects %s', (value) => {
    expect(() => testAgentTimeout(value)).toThrow(
      `DOKKIMI_HTTP_TIMEOUT must be a positive integer (milliseconds), got "${value}"`,
    );
  });
});
