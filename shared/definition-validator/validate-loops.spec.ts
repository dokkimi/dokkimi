import { validateLoopModifiers } from './validate-loops';
import { makeResult } from './test-helpers';

describe('validateLoopModifiers', () => {
  it('returns null when no loop modifier present', () => {
    const r = makeResult();
    expect(validateLoopModifiers({ name: 'test' }, 'ctx', r)).toBeNull();
    expect(r.errors).toHaveLength(0);
  });

  it('errors when multiple loop modifiers present', () => {
    const r = makeResult();
    validateLoopModifiers(
      { forEach: { items: [], as: 'x' }, for: { from: 0, to: 5, as: 'i' } },
      'ctx',
      r,
    );
    expect(r.errors[0]).toContain('only one loop modifier allowed');
  });

  // --- forEach ---

  it('accepts valid forEach', () => {
    const r = makeResult();
    validateLoopModifiers(
      { forEach: { items: ['a', 'b'], as: 'item' } },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('accepts forEach with string items', () => {
    const r = makeResult();
    validateLoopModifiers(
      { forEach: { items: '{{myVar}}', as: 'item' } },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('errors on forEach missing items', () => {
    const r = makeResult();
    validateLoopModifiers({ forEach: { as: 'item' } }, 'ctx', r);
    expect(r.errors.some((e) => e.includes('"items" is required'))).toBe(true);
  });

  it('errors on forEach with non-string non-array items', () => {
    const r = makeResult();
    validateLoopModifiers({ forEach: { items: 42, as: 'item' } }, 'ctx', r);
    expect(
      r.errors.some((e) => e.includes('"items" must be an array or a string')),
    ).toBe(true);
  });

  it('errors on forEach missing as', () => {
    const r = makeResult();
    validateLoopModifiers({ forEach: { items: [] } }, 'ctx', r);
    expect(r.errors.some((e) => e.includes('"as" is required'))).toBe(true);
  });

  it('errors on forEach with non-alphanumeric as', () => {
    const r = makeResult();
    validateLoopModifiers({ forEach: { items: [], as: 'bad-name' } }, 'ctx', r);
    expect(r.errors.some((e) => e.includes('alphanumeric'))).toBe(true);
  });

  it('accepts forEach with delayMs', () => {
    const r = makeResult();
    validateLoopModifiers(
      { forEach: { items: [], as: 'item', delayMs: 100 } },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('errors on forEach with negative delayMs', () => {
    const r = makeResult();
    validateLoopModifiers(
      { forEach: { items: [], as: 'item', delayMs: -1 } },
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('"delayMs"'))).toBe(true);
  });

  // --- for ---

  it('accepts valid for loop', () => {
    const r = makeResult();
    validateLoopModifiers({ for: { from: 0, to: 5, as: 'i' } }, 'ctx', r);
    expect(r.errors).toHaveLength(0);
  });

  it('accepts for with custom step', () => {
    const r = makeResult();
    validateLoopModifiers(
      { for: { from: 0, to: 10, step: 2, as: 'i' } },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('accepts descending for with negative step', () => {
    const r = makeResult();
    validateLoopModifiers(
      { for: { from: 10, to: 0, step: -2, as: 'i' } },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('errors on for with step 0', () => {
    const r = makeResult();
    validateLoopModifiers(
      { for: { from: 0, to: 5, step: 0, as: 'i' } },
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('"step" must not be 0'))).toBe(true);
  });

  it('errors when from > to without negative step', () => {
    const r = makeResult();
    validateLoopModifiers({ for: { from: 10, to: 0, as: 'i' } }, 'ctx', r);
    expect(r.errors.some((e) => e.includes('"from" must be <= "to"'))).toBe(
      true,
    );
  });

  it('errors when positive step but from > to', () => {
    const r = makeResult();
    validateLoopModifiers(
      { for: { from: 10, to: 0, step: 2, as: 'i' } },
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('"from" must be <= "to"'))).toBe(
      true,
    );
  });

  it('accepts from == to (single iteration)', () => {
    const r = makeResult();
    validateLoopModifiers({ for: { from: 5, to: 5, as: 'i' } }, 'ctx', r);
    expect(r.errors).toHaveLength(0);
  });

  // --- repeat ---

  it('accepts valid repeat', () => {
    const r = makeResult();
    validateLoopModifiers({ repeat: { count: 5, as: 'attempt' } }, 'ctx', r);
    expect(r.errors).toHaveLength(0);
  });

  it('errors on repeat with non-positive count', () => {
    const r = makeResult();
    validateLoopModifiers({ repeat: { count: 0, as: 'attempt' } }, 'ctx', r);
    expect(
      r.errors.some((e) => e.includes('"count" must be a positive integer')),
    ).toBe(true);
  });

  it('accepts repeat with until', () => {
    const r = makeResult();
    validateLoopModifiers(
      {
        repeat: {
          count: 10,
          as: 'attempt',
          until: [
            { path: '$.response.body.status', operator: 'eq', value: 'done' },
          ],
        },
      },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('errors on repeat with non-array until', () => {
    const r = makeResult();
    validateLoopModifiers(
      { repeat: { count: 10, as: 'attempt', until: 'bad' } },
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('"until" must be an array'))).toBe(
      true,
    );
  });

  it('errors on repeat with invalid until assertion operator', () => {
    const r = makeResult();
    validateLoopModifiers(
      {
        repeat: {
          count: 5,
          as: 'a',
          until: [{ path: '$.x', operator: 'invalid', value: 1 }],
        },
      },
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('operator must be one of'))).toBe(
      true,
    );
  });

  // ── Audit finding #1: $.path in forEach items accepted but fails at runtime ──

  it('should reject $.path in forEach items (only valid in assertion blocks)', () => {
    const r = makeResult();
    validateLoopModifiers(
      { forEach: { items: '$.response.body', as: 'item' } },
      'ctx',
      r,
    );
    // $.path items are only valid in assertion-block forEach where rootCtx
    // is available. At the step/action/test level, buildIterationPlan passes
    // nil rootCtx, so $.path silently fails at runtime.
    expect(
      r.errors.some((e) => e.includes('$.')) || r.warnings.length > 0,
    ).toBe(true);
  });

  // ── Audit finding #6: no upper bound on delayMs ──

  it('should reject or warn on unreasonably large delayMs', () => {
    const r = makeResult();
    validateLoopModifiers(
      { forEach: { items: [], as: 'item', delayMs: 999999999 } },
      'ctx',
      r,
    );
    // 999999999ms ≈ 11.5 days per iteration. The validator should cap this
    // or at least warn.
    const hasIssue = r.errors.length > 0 || r.warnings.length > 0;
    expect(hasIssue).toBe(true);
  });
});
