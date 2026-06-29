import {
  interpolateEnv,
  interpolateVars,
  findLeftoverVarRefs,
} from './env-substitution';

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

describe('interpolateVars', () => {
  it('replaces {{KEY}} in a string', () => {
    const result = interpolateVars(
      'Hello {{NAME}}!',
      { NAME: 'World' },
      new Set(),
    );
    expect(result).toBe('Hello World!');
  });

  it('replaces multiple references in one string', () => {
    const vars = { PASS: 'secret', HOST: 'my-redis', PORT: '6379' };
    const result = interpolateVars(
      'redis://:{{PASS}}@{{HOST}}:{{PORT}}',
      vars,
      new Set(),
    );
    expect(result).toBe('redis://:secret@my-redis:6379');
  });

  it('collects unresolved references', () => {
    const unresolved = new Set<string>();
    const result = interpolateVars('{{MISSING}}', {}, unresolved);
    expect(result).toBe('{{MISSING}}');
    expect(unresolved).toEqual(new Set(['MISSING']));
  });

  it('supports hyphenated variable names', () => {
    const result = interpolateVars(
      '{{my-var}}',
      { 'my-var': 'value' },
      new Set(),
    );
    expect(result).toBe('value');
  });

  it('recurses into arrays', () => {
    const result = interpolateVars(
      ['{{A}}', '{{B}}'],
      { A: '1', B: '2' },
      new Set(),
    );
    expect(result).toEqual(['1', '2']);
  });

  it('recurses into objects', () => {
    const result = interpolateVars(
      { host: '{{HOST}}', port: '{{PORT}}' },
      { HOST: 'localhost', PORT: '5432' },
      new Set(),
    );
    expect(result).toEqual({ host: 'localhost', port: '5432' });
  });

  it('recurses into nested structures', () => {
    const input = {
      env: [{ name: 'DB_URL', value: 'postgres://{{USER}}:{{PASS}}@db:5432' }],
    };
    const result = interpolateVars(
      input,
      { USER: 'admin', PASS: 'secret' },
      new Set(),
    );
    expect(result).toEqual({
      env: [{ name: 'DB_URL', value: 'postgres://admin:secret@db:5432' }],
    });
  });

  it('passes through numbers unchanged', () => {
    const result = interpolateVars(42, {}, new Set());
    expect(result).toBe(42);
  });

  it('passes through null unchanged', () => {
    const result = interpolateVars(null, {}, new Set());
    expect(result).toBeNull();
  });

  it('does not match ${{KEY}} syntax', () => {
    const result = interpolateVars(
      '${{NOT_A_MATCH}}',
      { NOT_A_MATCH: 'x' },
      new Set(),
    );
    expect(result).toBe('${{NOT_A_MATCH}}');
  });

  it('does not resolve dotted paths', () => {
    const unresolved = new Set<string>();
    const result = interpolateVars(
      '{{obj.field}}',
      { obj: 'value' },
      unresolved,
    );
    expect(result).toBe('{{obj.field}}');
  });

  it('does not recursively resolve variable values', () => {
    const vars = { HOST: 'my-redis', URL: 'redis://{{HOST}}:6379' };
    const result = interpolateVars('{{URL}}', vars, new Set());
    expect(result).toBe('redis://{{HOST}}:6379');
  });

  it('coexists with ${{}} in the same string', () => {
    const result = interpolateVars(
      'redis://:{{PASS}}@${{HOST}}:6379',
      { PASS: 'secret' },
      new Set(),
    );
    expect(result).toBe('redis://:secret@${{HOST}}:6379');
  });
});

describe('findLeftoverVarRefs', () => {
  it('returns empty array when no refs present', () => {
    expect(findLeftoverVarRefs('plain string')).toEqual([]);
  });

  it('finds simple unresolved refs', () => {
    expect(findLeftoverVarRefs('{{FOO}}')).toEqual(['{{FOO}}']);
  });

  it('finds dotted path refs', () => {
    expect(findLeftoverVarRefs('{{obj.field}}')).toEqual(['{{obj.field}}']);
  });

  it('finds array index refs', () => {
    expect(findLeftoverVarRefs('{{arr[0]}}')).toEqual(['{{arr[0]}}']);
  });

  it('finds multiple refs in one string', () => {
    const result = findLeftoverVarRefs('{{a}} and {{b.c}}');
    expect(result).toEqual(['{{a}}', '{{b.c}}']);
  });

  it('recurses into nested structures', () => {
    const input = {
      items: [{ env: [{ value: '{{leaked}}' }] }],
    };
    expect(findLeftoverVarRefs(input)).toEqual(['{{leaked}}']);
  });

  it('returns empty for non-string primitives', () => {
    expect(findLeftoverVarRefs(42)).toEqual([]);
    expect(findLeftoverVarRefs(null)).toEqual([]);
    expect(findLeftoverVarRefs(true)).toEqual([]);
  });

  it('does not match ${{}} syntax', () => {
    expect(findLeftoverVarRefs('${{CONFIG}}')).toEqual([]);
  });
});
