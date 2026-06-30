import { validateItem, validateInitFile } from './validate-items';
import { makeResult, makeMockFs } from './test-helpers';

// ---------------------------------------------------------------------------
// validateItem
// ---------------------------------------------------------------------------

describe('validateItem', () => {
  const fs = makeMockFs();

  describe('common fields', () => {
    it('errors on missing type', () => {
      const r = makeResult();
      validateItem({ name: 'svc' }, 0, '/f.json', r, fs);
      expect(r.errors[0]).toContain('"type" must be one of');
    });

    it('errors on invalid type', () => {
      const r = makeResult();
      validateItem({ type: 'INVALID', name: 'svc' }, 0, '/f.json', r, fs);
      expect(r.errors[0]).toContain('"type" must be one of');
    });

    it('errors on missing name', () => {
      const r = makeResult();
      validateItem({ type: 'SERVICE' }, 0, '/f.json', r, fs);
      expect(r.errors.some((e) => e.includes('missing or empty "name"'))).toBe(
        true,
      );
    });

    it('errors on invalid name format', () => {
      const r = makeResult();
      validateItem(
        { type: 'SERVICE', name: 'UPPER_CASE', port: 3000, healthCheck: '/h' },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) => e.includes('must be lowercase alphanumeric')),
      ).toBe(true);
    });

    it('errors on name exceeding 63 chars', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'SERVICE',
          name: 'a'.repeat(64),
          port: 3000,
          healthCheck: '/h',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors.some((e) => e.includes('exceeds 63 characters'))).toBe(
        true,
      );
    });

    it('warns on description exceeding 500 chars', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'SERVICE',
          name: 'svc',
          port: 3000,
          healthCheck: '/h',
          description: 'x'.repeat(501),
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.warnings.some((w) => w.includes('description exceeds'))).toBe(
        true,
      );
    });

    it('warns on unknown properties', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'SERVICE',
          name: 'svc',
          port: 3000,
          healthCheck: '/h',
          bogus: true,
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.warnings.some((w) => w.includes('unknown property "bogus"')),
      ).toBe(true);
    });
  });

  describe('stage', () => {
    it('accepts stage on SERVICE', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'SERVICE',
          name: 'svc',
          port: 3000,
          healthCheck: '/h',
          stage: 1,
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('accepts stage on DATABASE', () => {
      const r = makeResult();
      validateItem(
        { type: 'DATABASE', name: 'db', database: 'postgres', stage: 0 },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('accepts stage on BROKER', () => {
      const r = makeResult();
      validateItem(
        { type: 'BROKER', name: 'mq', broker: 'amqp', stage: 2 },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('warns on stage on MOCK (unknown property)', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'MOCK',
          name: 'mock',
          mockTarget: 'api.example.com',
          mockPath: '/foo',
          mockResponseStatus: 200,
          stage: 1,
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.warnings.some((w) => w.includes('unknown property "stage"')),
      ).toBe(true);
    });

    it('errors on negative stage', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'SERVICE',
          name: 'svc',
          port: 3000,
          healthCheck: '/h',
          stage: -1,
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors.some((e) => e.includes('non-negative integer'))).toBe(
        true,
      );
    });

    it('errors on non-integer stage', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'SERVICE',
          name: 'svc',
          port: 3000,
          healthCheck: '/h',
          stage: 1.5,
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors.some((e) => e.includes('non-negative integer'))).toBe(
        true,
      );
    });

    it('errors on string stage', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'SERVICE',
          name: 'svc',
          port: 3000,
          healthCheck: '/h',
          stage: 'first',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors.some((e) => e.includes('non-negative integer'))).toBe(
        true,
      );
    });
  });

  describe('SERVICE', () => {
    it('validates a valid service', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'SERVICE',
          name: 'svc',
          image: 'img:latest',
          port: 3000,
          healthCheck: '/health',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('warns when image is missing', () => {
      const r = makeResult();
      validateItem(
        { type: 'SERVICE', name: 'svc', port: 3000, healthCheck: '/health' },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.warnings.some((w) => w.includes('should have "image"'))).toBe(
        true,
      );
    });

    it('errors when healthCheck is missing', () => {
      const r = makeResult();
      validateItem(
        { type: 'SERVICE', name: 'svc', port: 3000 },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors.some((e) => e.includes('requires "healthCheck"'))).toBe(
        true,
      );
    });

    it('accepts tcp health check', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'SERVICE',
          name: 'kafka',
          port: 9092,
          healthCheck: 'tcp',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors on healthCheck that is not a path or tcp', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'SERVICE',
          name: 'svc',
          port: 3000,
          healthCheck: 'health',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) => e.includes('must be an HTTP path starting with')),
      ).toBe(true);
    });

    it('errors on invalid port', () => {
      const r = makeResult();
      validateItem(
        { type: 'SERVICE', name: 'svc', port: 99999, healthCheck: '/h' },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors.some((e) => e.includes('port must be an integer'))).toBe(
        true,
      );
    });

    it('errors on non-integer port', () => {
      const r = makeResult();
      validateItem(
        { type: 'SERVICE', name: 'svc', port: 3.5, healthCheck: '/h' },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors.some((e) => e.includes('port must be an integer'))).toBe(
        true,
      );
    });

    it('errors when env is not an array', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'SERVICE',
          name: 'svc',
          port: 3000,
          healthCheck: '/h',
          env: 'bad',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors.some((e) => e.includes('"env" must be an array'))).toBe(
        true,
      );
    });

    it('errors on malformed env entries', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'SERVICE',
          name: 'svc',
          port: 3000,
          healthCheck: '/h',
          env: [{ name: 'A' }],
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) => e.includes('env[0] must have "name" and "value"')),
      ).toBe(true);
    });

    it('accepts valid env entries', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'SERVICE',
          name: 'svc',
          port: 3000,
          healthCheck: '/h',
          env: [{ name: 'KEY', value: 'VAL' }],
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('accepts valid command array', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'SERVICE',
          name: 'svc',
          port: 3000,
          healthCheck: '/h',
          command: ['server', '/data'],
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors when command is not an array', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'SERVICE',
          name: 'svc',
          port: 3000,
          healthCheck: '/h',
          command: 'server /data',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) => e.includes('"command" must be an array')),
      ).toBe(true);
    });

    it('errors when command entries are not strings', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'SERVICE',
          name: 'svc',
          port: 3000,
          healthCheck: '/h',
          command: ['server', 42],
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) => e.includes('command[1] must be a string')),
      ).toBe(true);
    });
  });

  describe('WORKER', () => {
    it('validates a valid worker', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'WORKER',
          name: 'my-worker',
          image: 'my-image:latest',
          command: ['node', 'worker.js'],
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('warns when image is missing', () => {
      const r = makeResult();
      validateItem({ type: 'WORKER', name: 'my-worker' }, 0, '/f.json', r, fs);
      expect(r.warnings.some((w) => w.includes('should have "image"'))).toBe(
        true,
      );
    });

    it('errors on invalid command type', () => {
      const r = makeResult();
      validateItem(
        { type: 'WORKER', name: 'my-worker', image: 'x', command: 'bad' },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) => e.includes('"command" must be an array')),
      ).toBe(true);
    });

    it('warns on port field', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'WORKER',
          name: 'my-worker',
          image: 'x',
          port: 3000,
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.warnings.some((w) => w.includes('"port"'))).toBe(true);
    });

    it('warns on healthCheck field', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'WORKER',
          name: 'my-worker',
          image: 'x',
          healthCheck: '/health',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.warnings.some((w) => w.includes('"healthCheck"'))).toBe(true);
    });
  });

  describe('DATABASE', () => {
    it('validates a valid database', () => {
      const r = makeResult();
      validateItem(
        { type: 'DATABASE', name: 'pg', database: 'postgres' },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors on missing database engine', () => {
      const r = makeResult();
      validateItem({ type: 'DATABASE', name: 'pg' }, 0, '/f.json', r, fs);
      expect(r.errors.some((e) => e.includes('requires "database"'))).toBe(
        true,
      );
    });

    it('errors on invalid database engine', () => {
      const r = makeResult();
      validateItem(
        { type: 'DATABASE', name: 'pg', database: 'oracle' },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) => e.includes('requires "database" as one of')),
      ).toBe(true);
    });

    it('accepts a valid version string', () => {
      const r = makeResult();
      validateItem(
        { type: 'DATABASE', name: 'pg', database: 'postgres', version: '16' },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('accepts versions with dots and hyphens', () => {
      for (const version of ['8.0.32', '7.2-alpine', '7-bookworm']) {
        const r = makeResult();
        validateItem(
          { type: 'DATABASE', name: 'pg', database: 'postgres', version },
          0,
          '/f.json',
          r,
          fs,
        );
        expect(r.errors).toHaveLength(0);
      }
    });

    it('rejects empty string version', () => {
      const r = makeResult();
      validateItem(
        { type: 'DATABASE', name: 'pg', database: 'postgres', version: '' },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) =>
          e.includes('"version" must be a non-empty string'),
        ),
      ).toBe(true);
    });

    it('rejects non-string version', () => {
      const r = makeResult();
      validateItem(
        { type: 'DATABASE', name: 'pg', database: 'postgres', version: 16 },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) =>
          e.includes('"version" must be a non-empty string'),
        ),
      ).toBe(true);
    });

    it('rejects "latest" as a version', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'DATABASE',
          name: 'pg',
          database: 'postgres',
          version: 'latest',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) => e.includes('"version" must start with a digit')),
      ).toBe(true);
    });

    it('rejects version containing a colon (image tag injection)', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'DATABASE',
          name: 'pg',
          database: 'postgres',
          version: 'postgres:16',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) => e.includes('"version" must start with a digit')),
      ).toBe(true);
    });

    it('validates initFilePath when file exists', () => {
      const fsWithFile = makeMockFs({ '/init/schema.sql': 'CREATE TABLE ...' });
      const r = makeResult();
      validateItem(
        {
          type: 'DATABASE',
          name: 'pg',
          database: 'postgres',
          initFilePath: '../init/schema.sql',
        },
        0,
        '/defs/test.json',
        r,
        fsWithFile,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors when initFilePath file is missing', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'DATABASE',
          name: 'pg',
          database: 'postgres',
          initFilePath: '../init/missing.sql',
        },
        0,
        '/defs/test.json',
        r,
        fs,
      );
      expect(r.errors.some((e) => e.includes('init file not found'))).toBe(
        true,
      );
    });

    it('errors when initFilePaths is not an array', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'DATABASE',
          name: 'pg',
          database: 'postgres',
          initFilePaths: 'bad',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) => e.includes('"initFilePaths" must be an array')),
      ).toBe(true);
    });

    it('validates each file in initFilePaths', () => {
      const fsWithFile = makeMockFs({ '/init/a.sql': '' });
      const r = makeResult();
      validateItem(
        {
          type: 'DATABASE',
          name: 'pg',
          database: 'postgres',
          initFilePaths: ['../init/a.sql', '../init/b.sql'],
        },
        0,
        '/defs/test.json',
        r,
        fsWithFile,
      );
      // a.sql exists, b.sql doesn't
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toContain('b.sql');
    });

    it('accepts noAuth: true', () => {
      const r = makeResult();
      validateItem(
        { type: 'DATABASE', name: 'redis', database: 'redis', noAuth: true },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('accepts noAuth: false with credentials', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'DATABASE',
          name: 'pg',
          database: 'postgres',
          noAuth: false,
          dbUser: 'admin',
          dbPassword: 'secret',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors when noAuth is not a boolean', () => {
      const r = makeResult();
      validateItem(
        { type: 'DATABASE', name: 'redis', database: 'redis', noAuth: 'yes' },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) => e.includes('"noAuth" must be a boolean')),
      ).toBe(true);
    });

    it('errors when noAuth: true is combined with dbPassword', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'DATABASE',
          name: 'redis',
          database: 'redis',
          noAuth: true,
          dbPassword: 'secret',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) => e.includes('"noAuth" cannot be combined')),
      ).toBe(true);
    });

    it('errors when noAuth: true is combined with dbUser', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'DATABASE',
          name: 'pg',
          database: 'postgres',
          noAuth: true,
          dbUser: 'admin',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) => e.includes('"noAuth" cannot be combined')),
      ).toBe(true);
    });

    it('errors when noAuth: true is combined with dbName', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'DATABASE',
          name: 'pg',
          database: 'postgres',
          noAuth: true,
          dbName: 'mydb',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) => e.includes('"noAuth" cannot be combined')),
      ).toBe(true);
    });
  });

  describe('BROKER', () => {
    it('validates a valid AMQP broker', () => {
      const r = makeResult();
      validateItem(
        { type: 'BROKER', name: 'rabbit', broker: 'amqp' },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('validates a valid Kafka broker', () => {
      const r = makeResult();
      validateItem(
        { type: 'BROKER', name: 'kafka', broker: 'kafka' },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors on missing broker type', () => {
      const r = makeResult();
      validateItem({ type: 'BROKER', name: 'rabbit' }, 0, '/f.json', r, fs);
      expect(r.errors.some((e) => e.includes('BROKER requires "broker"'))).toBe(
        true,
      );
    });

    it('errors on invalid broker type', () => {
      const r = makeResult();
      validateItem(
        { type: 'BROKER', name: 'rabbit', broker: 'nats' },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors.some((e) => e.includes('BROKER requires "broker"'))).toBe(
        true,
      );
    });

    it('errors on non-integer port', () => {
      const r = makeResult();
      validateItem(
        { type: 'BROKER', name: 'rabbit', broker: 'amqp', port: 'banana' },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors.some((e) => e.includes('port must be an integer'))).toBe(
        true,
      );
    });

    it('accepts valid port', () => {
      const r = makeResult();
      validateItem(
        { type: 'BROKER', name: 'rabbit', broker: 'amqp', port: 5672 },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors on non-string healthCheck', () => {
      const r = makeResult();
      validateItem(
        { type: 'BROKER', name: 'rabbit', broker: 'amqp', healthCheck: 123 },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) => e.includes('"healthCheck" must be a string')),
      ).toBe(true);
    });

    it('errors when command is not an array', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'BROKER',
          name: 'rabbit',
          broker: 'amqp',
          command: 'start',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) => e.includes('"command" must be an array')),
      ).toBe(true);
    });

    it('errors when env is not an array', () => {
      const r = makeResult();
      validateItem(
        { type: 'BROKER', name: 'rabbit', broker: 'amqp', env: 'bad' },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors.some((e) => e.includes('"env" must be an array'))).toBe(
        true,
      );
    });

    it('errors on malformed env entries', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'BROKER',
          name: 'rabbit',
          broker: 'amqp',
          env: [{ name: 'A' }],
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) => e.includes('env[0] must have "name" and "value"')),
      ).toBe(true);
    });

    it('accepts all optional fields together', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'BROKER',
          name: 'rabbit',
          broker: 'amqp',
          image: 'rabbitmq:3.13',
          port: 5672,
          healthCheck: 'tcp',
          command: ['rabbitmq-server'],
          env: [{ name: 'K', value: 'V' }],
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
    });
  });

  describe('MOCK', () => {
    it('validates a valid mock', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'MOCK',
          name: 'mock-stripe',
          mockTarget: 'api.stripe.com',
          mockPath: '/v1/charges',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors on missing mockTarget', () => {
      const r = makeResult();
      validateItem(
        { type: 'MOCK', name: 'mock-stripe', mockPath: '/v1/charges' },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors.some((e) => e.includes('requires "mockTarget"'))).toBe(
        true,
      );
    });

    it('errors on missing mockPath', () => {
      const r = makeResult();
      validateItem(
        { type: 'MOCK', name: 'mock-stripe', mockTarget: 'api.stripe.com' },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors.some((e) => e.includes('requires "mockPath"'))).toBe(
        true,
      );
    });

    it('errors on invalid mockMethod', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'MOCK',
          name: 'mock-stripe',
          mockTarget: 'api.stripe.com',
          mockPath: '/',
          mockMethod: 'BOGUS',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) =>
          e.includes('mockMethod must be a valid HTTP method'),
        ),
      ).toBe(true);
    });

    it('accepts wildcard mockMethod', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'MOCK',
          name: 'mock-stripe',
          mockTarget: 'api.stripe.com',
          mockPath: '/',
          mockMethod: '*',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors on invalid mockResponseStatus', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'MOCK',
          name: 'mock-stripe',
          mockTarget: 'api.stripe.com',
          mockPath: '/',
          mockResponseStatus: 999,
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors.some((e) => e.includes('mockResponseStatus'))).toBe(true);
    });

    it('errors on invalid mockDelayMs', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'MOCK',
          name: 'mock-stripe',
          mockTarget: 'api.stripe.com',
          mockPath: '/',
          mockDelayMs: -1,
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors.some((e) => e.includes('mockDelayMs'))).toBe(true);
    });

    it('accepts valid mockRequestBodyContains', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'MOCK',
          name: 'mock-llm',
          mockTarget: 'api.openai.com',
          mockPath: '/v1/chat/completions',
          mockRequestBodyContains: 'classify this ticket',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('accepts valid mockRequestBodyMatches', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'MOCK',
          name: 'mock-llm',
          mockTarget: 'api.openai.com',
          mockPath: '/v1/chat/completions',
          mockRequestBodyMatches: '"name":\\s*"search_database"',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors on non-string mockRequestBodyContains', () => {
      const r = makeResult();
      const item = {
        type: 'MOCK',
        name: 'mock-llm',
        mockTarget: 'api.openai.com',
        mockPath: '/',
        mockRequestBodyContains: 123,
      };
      validateItem(item, 0, '/f.json', r, fs);
      expect(
        r.errors.some((e) =>
          e.includes('mockRequestBodyContains must be a string'),
        ),
      ).toBe(true);
    });

    it('errors on empty mockRequestBodyContains', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'MOCK',
          name: 'mock-llm',
          mockTarget: 'api.openai.com',
          mockPath: '/',
          mockRequestBodyContains: '',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) =>
          e.includes('mockRequestBodyContains must be non-empty'),
        ),
      ).toBe(true);
    });

    it('errors on non-string mockRequestBodyMatches', () => {
      const r = makeResult();
      const badItem = {
        type: 'MOCK',
        name: 'mock-llm',
        mockTarget: 'api.openai.com',
        mockPath: '/',
        mockRequestBodyMatches: 123,
      };
      validateItem(badItem, 0, '/f.json', r, fs);
      expect(
        r.errors.some((e) =>
          e.includes('mockRequestBodyMatches must be a string'),
        ),
      ).toBe(true);
    });

    it('errors on empty mockRequestBodyMatches', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'MOCK',
          name: 'mock-llm',
          mockTarget: 'api.openai.com',
          mockPath: '/',
          mockRequestBodyMatches: '',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) =>
          e.includes('mockRequestBodyMatches must be non-empty'),
        ),
      ).toBe(true);
    });

    it('errors on invalid regex in mockRequestBodyMatches', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'MOCK',
          name: 'mock-llm',
          mockTarget: 'api.openai.com',
          mockPath: '/',
          mockRequestBodyMatches: '[invalid',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) =>
          e.includes('mockRequestBodyMatches is not a valid regex'),
        ),
      ).toBe(true);
    });

    it('errors when both mockRequestBodyContains and mockRequestBodyMatches are present', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'MOCK',
          name: 'mock-llm',
          mockTarget: 'api.openai.com',
          mockPath: '/',
          mockRequestBodyContains: 'test',
          mockRequestBodyMatches: 'test',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors.some((e) => e.includes('mutually exclusive'))).toBe(true);
    });
  });

  describe('HTTP_REQUEST', () => {
    it('validates a valid HTTP_REQUEST', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'HTTP_REQUEST',
          name: 'req',
          requestMethod: 'GET',
          requestUrl: '/api',
          requestTarget: 'svc',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors on missing requestMethod', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'HTTP_REQUEST',
          name: 'req',
          requestUrl: '/api',
          requestTarget: 'svc',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) => e.includes('requires valid "requestMethod"')),
      ).toBe(true);
    });

    it('errors on missing requestUrl', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'HTTP_REQUEST',
          name: 'req',
          requestMethod: 'GET',
          requestTarget: 'svc',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors.some((e) => e.includes('requires "requestUrl"'))).toBe(
        true,
      );
    });

    it('errors on missing requestTarget', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'HTTP_REQUEST',
          name: 'req',
          requestMethod: 'GET',
          requestUrl: '/api',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors.some((e) => e.includes('requires "requestTarget"'))).toBe(
        true,
      );
    });

    it('errors on invalid requestProtocol', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'HTTP_REQUEST',
          name: 'req',
          requestMethod: 'GET',
          requestUrl: '/api',
          requestTarget: 'svc',
          requestProtocol: 'ftp',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(
        r.errors.some((e) => e.includes('requestProtocol must be one of')),
      ).toBe(true);
    });
  });

  describe('DB_QUERY', () => {
    it('validates a valid DB_QUERY', () => {
      const r = makeResult();
      validateItem(
        {
          type: 'DB_QUERY',
          name: 'query',
          queryTarget: 'pg',
          queryText: 'SELECT 1',
        },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors).toHaveLength(0);
    });

    it('errors on missing queryTarget', () => {
      const r = makeResult();
      validateItem(
        { type: 'DB_QUERY', name: 'query', queryText: 'SELECT 1' },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors.some((e) => e.includes('requires "queryTarget"'))).toBe(
        true,
      );
    });

    it('errors on missing queryText', () => {
      const r = makeResult();
      validateItem(
        { type: 'DB_QUERY', name: 'query', queryTarget: 'pg' },
        0,
        '/f.json',
        r,
        fs,
      );
      expect(r.errors.some((e) => e.includes('requires "queryText"'))).toBe(
        true,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// validateInitFile
// ---------------------------------------------------------------------------

describe('validateInitFile', () => {
  it('passes when file exists', () => {
    const fs = makeMockFs({ '/project/init/schema.sql': '' });
    const r = makeResult();
    validateInitFile(
      '../init/schema.sql',
      'ctx',
      '/project/defs/test.json',
      r,
      fs,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('errors when file does not exist', () => {
    const fs = makeMockFs();
    const r = makeResult();
    validateInitFile(
      '../init/missing.sql',
      'ctx',
      '/project/defs/test.json',
      r,
      fs,
    );
    expect(r.errors[0]).toContain('init file not found');
  });

  it('errors on empty path', () => {
    const fs = makeMockFs();
    const r = makeResult();
    validateInitFile('', 'ctx', '/f.json', r, fs);
    expect(r.errors[0]).toContain('must be a non-empty string');
  });
});
