import {
  err,
  warn,
  checkUnknownKeys,
  ValidationResult,
} from './validate-helpers';

function makeResult(): ValidationResult {
  return { file: '/test.json', kind: 'definition', errors: [], warnings: [] };
}

describe('err', () => {
  it('pushes to errors array', () => {
    const r = makeResult();
    err(r, 'something broke');
    expect(r.errors).toEqual(['something broke']);
  });
});

describe('warn', () => {
  it('pushes to warnings array', () => {
    const r = makeResult();
    warn(r, 'heads up');
    expect(r.warnings).toEqual(['heads up']);
  });
});

describe('checkUnknownKeys', () => {
  it('does nothing when all keys are valid', () => {
    const r = makeResult();
    checkUnknownKeys({ a: 1, b: 2 }, new Set(['a', 'b']), 'ctx', r);
    expect(r.warnings).toHaveLength(0);
  });

  it('warns on unknown keys', () => {
    const r = makeResult();
    checkUnknownKeys({ a: 1, bogus: 2 }, new Set(['a']), 'ctx', r);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('unknown property "bogus"');
  });

  it('warns on each unknown key', () => {
    const r = makeResult();
    checkUnknownKeys({ a: 1, x: 2, y: 3 }, new Set(['a']), 'ctx', r);
    expect(r.warnings).toHaveLength(2);
  });
});
