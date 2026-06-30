import { Test, TestingModule } from '@nestjs/testing';
import {
  DatabaseConfigService,
  resolveDbCredentials,
} from './database-config.service';

describe('DatabaseConfigService', () => {
  let service: DatabaseConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DatabaseConfigService],
    }).compile();

    service = module.get<DatabaseConfigService>(DatabaseConfigService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getConfig', () => {
    it('should return PostgreSQL config', () => {
      const config = service.getConfig('postgres');

      expect(config.image).toBe('postgres:15');
      expect(config.environment.POSTGRES_DB).toBe('dokkimi');
      expect(config.environment.POSTGRES_USER).toBe('dokkimi');
      expect(config.ports).toEqual([5432]);
    });

    it('should return MySQL config', () => {
      const config = service.getConfig('mysql');

      expect(config.image).toBe('mysql:8');
      expect(config.environment.MYSQL_DATABASE).toBe('dokkimi');
      expect(config.environment.MYSQL_USER).toBe('dokkimi');
      expect(config.ports).toEqual([3306]);
    });

    it('should return MongoDB config', () => {
      const config = service.getConfig('mongodb');

      expect(config.image).toBe('mongo:7');
      expect(config.environment.MONGO_INITDB_DATABASE).toBe('dokkimi');
      expect(config.ports).toEqual([27017]);
    });

    it('should be case insensitive', () => {
      const config1 = service.getConfig('POSTGRES');
      const config2 = service.getConfig('postgres');

      expect(config1.image).toBe(config2.image);
    });

    it('should return default config for unknown database type', () => {
      const config = service.getConfig('unknown-db');

      expect(config.image).toBe('unknown-db:latest');
      expect(config.environment).toEqual({});
      expect(config.ports).toEqual([]);
    });

    it('should use explicit version for PostgreSQL', () => {
      const config = service.getConfig('postgres', undefined, '16');

      expect(config.image).toBe('postgres:16');
    });

    it('should use explicit version for MySQL', () => {
      const config = service.getConfig('mysql', undefined, '8.0');

      expect(config.image).toBe('mysql:8.0');
    });

    it('should use explicit version for MongoDB', () => {
      const config = service.getConfig('mongodb', undefined, '6');

      expect(config.image).toBe('mongo:6');
    });

    it('should use Redis version verbatim (no auto -alpine suffix)', () => {
      expect(service.getConfig('redis', undefined, '6').image).toBe('redis:6');
      expect(service.getConfig('redis', undefined, '7-alpine').image).toBe(
        'redis:7-alpine',
      );
      expect(service.getConfig('redis', undefined, '7-bookworm').image).toBe(
        'redis:7-bookworm',
      );
    });

    it('should fall back to default version when version is not provided', () => {
      expect(service.getConfig('postgres').image).toBe('postgres:15');
      expect(service.getConfig('mysql').image).toBe('mysql:8');
      expect(service.getConfig('mongodb').image).toBe('mongo:7');
      expect(service.getConfig('redis').image).toBe('redis:7-alpine');
    });

    it('should use provided version for unknown database type', () => {
      const config = service.getConfig('unknown-db', undefined, '3.2');

      expect(config.image).toBe('unknown-db:3.2');
    });

    it('should fall back to latest for unknown database type without version', () => {
      const config = service.getConfig('unknown-db');

      expect(config.image).toBe('unknown-db:latest');
    });

    it('should set POSTGRES_HOST_AUTH_METHOD=trust when noAuth is true', () => {
      const config = service.getConfig('postgres', { noAuth: true });

      expect(config.environment.POSTGRES_HOST_AUTH_METHOD).toBe('trust');
      expect(config.environment.POSTGRES_PASSWORD).toBe('');
      expect(config.environment.POSTGRES_USER).toBe('');
    });

    it('should not set POSTGRES_HOST_AUTH_METHOD when noAuth is false', () => {
      const config = service.getConfig('postgres', { noAuth: false });

      expect(config.environment.POSTGRES_HOST_AUTH_METHOD).toBeUndefined();
      expect(config.environment.POSTGRES_PASSWORD).toBe('dokkimi');
    });

    it('should set MYSQL_ALLOW_EMPTY_PASSWORD=yes when noAuth is true', () => {
      const config = service.getConfig('mysql', { noAuth: true });

      expect(config.environment.MYSQL_ALLOW_EMPTY_PASSWORD).toBe('yes');
      expect(config.environment.MYSQL_PASSWORD).toBe('');
      expect(config.environment.MYSQL_USER).toBe('');
    });

    it('should not set MYSQL_ALLOW_EMPTY_PASSWORD when noAuth is false', () => {
      const config = service.getConfig('mysql', { noAuth: false });

      expect(config.environment.MYSQL_ALLOW_EMPTY_PASSWORD).toBeUndefined();
      expect(config.environment.MYSQL_PASSWORD).toBe('dokkimi');
    });
  });

  describe('resolveDbCredentials', () => {
    it('should return defaults when no credentials provided', () => {
      const result = resolveDbCredentials(undefined);

      expect(result).toEqual({
        dbName: 'dokkimi',
        dbUser: 'dokkimi',
        dbPassword: 'dokkimi',
      });
    });

    it('should use custom values when provided', () => {
      const result = resolveDbCredentials({
        dbName: 'mydb',
        dbUser: 'myuser',
        dbPassword: 'mypass',
      });

      expect(result).toEqual({
        dbName: 'mydb',
        dbUser: 'myuser',
        dbPassword: 'mypass',
      });
    });

    it('should return empty strings when noAuth is true', () => {
      const result = resolveDbCredentials({ noAuth: true });

      expect(result).toEqual({
        dbName: '',
        dbUser: '',
        dbPassword: '',
      });
    });

    it('should ignore custom values when noAuth is true', () => {
      const result = resolveDbCredentials({
        noAuth: true,
        dbName: 'mydb',
        dbUser: 'myuser',
        dbPassword: 'mypass',
      });

      expect(result).toEqual({
        dbName: '',
        dbUser: '',
        dbPassword: '',
      });
    });

    it('should use defaults for missing fields when noAuth is false', () => {
      const result = resolveDbCredentials({
        noAuth: false,
        dbName: 'custom',
      });

      expect(result.dbName).toBe('custom');
      expect(result.dbUser).toBe('dokkimi');
      expect(result.dbPassword).toBe('dokkimi');
    });

    it('should treat null fields as unset and use defaults', () => {
      const result = resolveDbCredentials({
        dbName: null,
        dbUser: null,
        dbPassword: null,
      });

      expect(result).toEqual({
        dbName: 'dokkimi',
        dbUser: 'dokkimi',
        dbPassword: 'dokkimi',
      });
    });
  });
});
