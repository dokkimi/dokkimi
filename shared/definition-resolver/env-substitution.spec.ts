import { interpolateEnv } from './env-substitution';

describe('interpolateEnv', () => {
  it('replaces ${{KEY}} in a string', () => {
    const result = interpolateEnv(
      'Hello ${{NAME}}!',
      { NAME: 'World' },
      new Set(),
    );
    expect(result).toBe('Hello World!');
  });

  it('replaces multiple placeholders in one string', () => {
    const env = { HOST: 'localhost', PORT: '3000' };
    const result = interpolateEnv('${{HOST}}:${{PORT}}', env, new Set());
    expect(result).toBe('localhost:3000');
  });

  it('collects unresolved references', () => {
    const unresolved = new Set<string>();
    const result = interpolateEnv('${{MISSING}}', {}, unresolved);
    expect(result).toBe('${{MISSING}}');
    expect(unresolved).toEqual(new Set(['MISSING']));
  });

  it('collects multiple unresolved keys', () => {
    const unresolved = new Set<string>();
    interpolateEnv('${{A}} and ${{B}}', {}, unresolved);
    expect(unresolved).toEqual(new Set(['A', 'B']));
  });

  it('mixes resolved and unresolved in one string', () => {
    const unresolved = new Set<string>();
    const result = interpolateEnv(
      '${{HOST}}:${{PORT}}',
      { HOST: 'db' },
      unresolved,
    );
    expect(result).toBe('db:${{PORT}}');
    expect(unresolved).toEqual(new Set(['PORT']));
  });

  it('recurses into arrays', () => {
    const result = interpolateEnv(
      ['${{A}}', '${{B}}'],
      { A: '1', B: '2' },
      new Set(),
    );
    expect(result).toEqual(['1', '2']);
  });

  it('recurses into objects', () => {
    const result = interpolateEnv(
      { host: '${{HOST}}', port: '${{PORT}}' },
      { HOST: 'localhost', PORT: '5432' },
      new Set(),
    );
    expect(result).toEqual({ host: 'localhost', port: '5432' });
  });

  it('recurses into nested structures', () => {
    const input = {
      items: [{ url: 'http://${{HOST}}:${{PORT}}' }],
    };
    const result = interpolateEnv(
      input,
      { HOST: 'api', PORT: '8080' },
      new Set(),
    );
    expect(result).toEqual({
      items: [{ url: 'http://api:8080' }],
    });
  });

  it('passes through numbers unchanged', () => {
    const result = interpolateEnv(42, {}, new Set());
    expect(result).toBe(42);
  });

  it('passes through booleans unchanged', () => {
    const result = interpolateEnv(true, {}, new Set());
    expect(result).toBe(true);
  });

  it('passes through null unchanged', () => {
    const result = interpolateEnv(null, {}, new Set());
    expect(result).toBeNull();
  });

  it('leaves strings without placeholders unchanged', () => {
    const result = interpolateEnv(
      'no placeholders here',
      { X: 'y' },
      new Set(),
    );
    expect(result).toBe('no placeholders here');
  });

  it('does not match single-brace syntax', () => {
    const result = interpolateEnv(
      '${NOT_A_MATCH}',
      { NOT_A_MATCH: 'x' },
      new Set(),
    );
    expect(result).toBe('${NOT_A_MATCH}');
  });
});
