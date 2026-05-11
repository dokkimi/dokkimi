import { sanitizeK8sName } from './k8s.utils';

describe('sanitizeK8sName', () => {
  it('lowercases uppercase characters', () => {
    expect(sanitizeK8sName('MyService')).toBe('myservice');
  });

  it('replaces non-alphanumeric characters with dashes', () => {
    expect(sanitizeK8sName('my_service.v2')).toBe('my-service-v2');
  });

  it('removes leading dashes', () => {
    expect(sanitizeK8sName('--my-service')).toBe('my-service');
  });

  it('removes trailing dashes', () => {
    expect(sanitizeK8sName('my-service--')).toBe('my-service');
  });

  it('truncates to 63 characters', () => {
    const long = 'a'.repeat(70);
    expect(sanitizeK8sName(long)).toHaveLength(63);
  });

  it('removes trailing dash after truncation', () => {
    const name = 'a'.repeat(62) + '-b';
    const result = sanitizeK8sName(name);
    expect(result.endsWith('-')).toBe(false);
    expect(result.length).toBeLessThanOrEqual(63);
  });

  it('handles already-valid names', () => {
    expect(sanitizeK8sName('my-service-123')).toBe('my-service-123');
  });

  it('handles spaces', () => {
    expect(sanitizeK8sName('my service')).toBe('my-service');
  });
});
