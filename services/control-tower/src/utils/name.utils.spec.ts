import { sanitizeContainerName } from './name.utils';

describe('sanitizeContainerName', () => {
  it('lowercases uppercase characters', () => {
    expect(sanitizeContainerName('MyService')).toBe('myservice');
  });

  it('replaces non-alphanumeric characters with dashes', () => {
    expect(sanitizeContainerName('my_service.v2')).toBe('my-service-v2');
  });

  it('removes leading dashes', () => {
    expect(sanitizeContainerName('--my-service')).toBe('my-service');
  });

  it('removes trailing dashes', () => {
    expect(sanitizeContainerName('my-service--')).toBe('my-service');
  });

  it('truncates to 63 characters', () => {
    const long = 'a'.repeat(70);
    expect(sanitizeContainerName(long)).toHaveLength(63);
  });

  it('removes trailing dash after truncation', () => {
    const name = 'a'.repeat(62) + '-b';
    const result = sanitizeContainerName(name);
    expect(result.endsWith('-')).toBe(false);
    expect(result.length).toBeLessThanOrEqual(63);
  });

  it('handles already-valid names', () => {
    expect(sanitizeContainerName('my-service-123')).toBe('my-service-123');
  });

  it('handles spaces', () => {
    expect(sanitizeContainerName('my service')).toBe('my-service');
  });
});
