import { buildEnvVars, buildResources } from './deployment-builder.utils';

describe('buildEnvVars', () => {
  it('should return empty array for null input', () => {
    expect(buildEnvVars(null)).toEqual([]);
  });

  it('should return empty array for undefined input', () => {
    expect(buildEnvVars(undefined)).toEqual([]);
  });

  it('should convert array format to V1EnvVar[]', () => {
    const env = [
      { name: 'FOO', value: 'bar' },
      { name: 'BAZ', value: 'qux' },
    ];
    expect(buildEnvVars(env)).toEqual([
      { name: 'FOO', value: 'bar' },
      { name: 'BAZ', value: 'qux' },
    ]);
  });

  it('should convert object format to V1EnvVar[]', () => {
    const env = { FOO: 'bar', BAZ: 'qux' };
    const result = buildEnvVars(env);
    expect(result).toEqual([
      { name: 'FOO', value: 'bar' },
      { name: 'BAZ', value: 'qux' },
    ]);
  });

  it('should stringify numeric values', () => {
    const result = buildEnvVars({ PORT: 8080 });
    expect(result).toEqual([{ name: 'PORT', value: '8080' }]);
  });

  it('should stringify boolean values', () => {
    const result = buildEnvVars({ DEBUG: true });
    expect(result).toEqual([{ name: 'DEBUG', value: 'true' }]);
  });

  it('should stringify null values to empty string', () => {
    const result = buildEnvVars({ EMPTY: null });
    expect(result).toEqual([{ name: 'EMPTY', value: '' }]);
  });

  it('should filter out array entries with empty name', () => {
    const env = [
      { name: '', value: 'ignored' },
      { name: 'KEEP', value: 'this' },
    ];
    expect(buildEnvVars(env)).toEqual([{ name: 'KEEP', value: 'this' }]);
  });

  it('should skip array entries without name/value keys', () => {
    const env = [{ random: 'object' }, { name: 'OK', value: 'yes' }];
    expect(buildEnvVars(env)).toEqual([{ name: 'OK', value: 'yes' }]);
  });

  it('should handle numeric values in array format', () => {
    const env = [{ name: 'PORT', value: 3000 }];
    expect(buildEnvVars(env)).toEqual([{ name: 'PORT', value: '3000' }]);
  });
});

describe('buildResources', () => {
  const base = { name: 'svc', k8sName: 'svc', type: 'SERVICE' } as const;

  it('should return empty object when no resource fields are set', () => {
    expect(buildResources({ ...base })).toEqual({});
  });

  it('should set requests when minCpu and minMemory are provided', () => {
    const result = buildResources({ ...base, minCpu: 500, minMemory: 256 });
    expect(result).toEqual({
      requests: { cpu: '500', memory: '256Mi' },
      limits: {},
    });
  });

  it('should set limits when maxCpu and maxMemory are provided', () => {
    const result = buildResources({ ...base, maxCpu: 2, maxMemory: 1024 });
    expect(result).toEqual({
      requests: {},
      limits: { cpu: '2', memory: '1024Mi' },
    });
  });

  it('should set all fields when fully specified', () => {
    const result = buildResources({
      ...base,
      minCpu: 100,
      minMemory: 128,
      maxCpu: 1,
      maxMemory: 512,
    });
    expect(result).toEqual({
      requests: { cpu: '100', memory: '128Mi' },
      limits: { cpu: '1', memory: '512Mi' },
    });
  });

  it('should handle partial fields (only minCpu)', () => {
    const result = buildResources({ ...base, minCpu: 250 });
    expect(result).toEqual({
      requests: { cpu: '250' },
      limits: {},
    });
  });

  it('should handle partial fields (only maxMemory)', () => {
    const result = buildResources({ ...base, maxMemory: 2048 });
    expect(result).toEqual({
      requests: {},
      limits: { memory: '2048Mi' },
    });
  });
});
