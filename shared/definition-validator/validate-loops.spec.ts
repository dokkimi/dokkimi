import {
  validateLoopModifiers,
  validateLoopBody,
  validateLoopSiblingConflicts,
} from './validate-loops';
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

  it('accepts repeat.until with type source field shorthand', () => {
    const r = makeResult();
    validateLoopModifiers(
      {
        repeat: {
          count: 5,
          as: 'a',
          until: [
            { type: '$.response.body.result', operator: 'eq', value: 'array' },
          ],
        },
      },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('accepts repeat.until with count source field shorthand', () => {
    const r = makeResult();
    validateLoopModifiers(
      {
        repeat: {
          count: 10,
          as: 'a',
          until: [
            { count: '$.response.body.items', operator: 'gte', value: 3 },
          ],
        },
      },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('accepts repeat.until with PathWithTransform', () => {
    const r = makeResult();
    validateLoopModifiers(
      {
        repeat: {
          count: 5,
          as: 'a',
          until: [
            {
              path: { from: '$.response.body.items', transform: 'length' },
              operator: 'gte',
              value: 5,
            },
          ],
        },
      },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('errors on repeat.until with no source field', () => {
    const r = makeResult();
    validateLoopModifiers(
      {
        repeat: {
          count: 5,
          as: 'a',
          until: [{ operator: 'eq', value: 'done' }],
        },
      },
      'ctx',
      r,
    );
    expect(
      r.errors.some((e) => e.includes('must have exactly one source field')),
    ).toBe(true);
  });

  it('errors on repeat.until with multiple source fields', () => {
    const r = makeResult();
    validateLoopModifiers(
      {
        repeat: {
          count: 5,
          as: 'a',
          until: [
            {
              path: '$.response.status',
              type: '$.response.body',
              operator: 'eq',
              value: 200,
            },
          ],
        },
      },
      'ctx',
      r,
    );
    expect(
      r.errors.some((e) => e.includes('only one source field allowed')),
    ).toBe(true);
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

// ---------------------------------------------------------------------------
// Phase 13: Level-based loop body validation
// ---------------------------------------------------------------------------

describe('validateLoopBody', () => {
  // ── test level ──

  it('test-level: allows steps in body', () => {
    const r = makeResult();
    validateLoopBody({ steps: [] }, 'ctx', r, 'test');
    expect(r.errors).toHaveLength(0);
  });

  it('test-level: rejects action in body', () => {
    const r = makeResult();
    validateLoopBody({ action: {} }, 'ctx', r, 'test');
    expect(
      r.errors.some((e) =>
        e.includes('"action" is not allowed in a test-level loop body'),
      ),
    ).toBe(true);
  });

  it('test-level: rejects assertions in body', () => {
    const r = makeResult();
    validateLoopBody({ assertions: [] }, 'ctx', r, 'test');
    expect(
      r.errors.some((e) =>
        e.includes('"assertions" is not allowed in a test-level loop body'),
      ),
    ).toBe(true);
  });

  it('test-level: rejects extract in body', () => {
    const r = makeResult();
    validateLoopBody({ extract: {} }, 'ctx', r, 'test');
    expect(
      r.errors.some((e) =>
        e.includes('"extract" is not allowed in a test-level loop body'),
      ),
    ).toBe(true);
  });

  it('test-level: rejects match in body', () => {
    const r = makeResult();
    validateLoopBody({ match: {} }, 'ctx', r, 'test');
    expect(
      r.errors.some((e) =>
        e.includes('"match" is not allowed in a test-level loop body'),
      ),
    ).toBe(true);
  });

  // ── step level ──

  it('step-level: allows action in body', () => {
    const r = makeResult();
    validateLoopBody({ action: {} }, 'ctx', r, 'step');
    expect(r.errors).toHaveLength(0);
  });

  it('step-level: allows assertions in body', () => {
    const r = makeResult();
    validateLoopBody({ assertions: [] }, 'ctx', r, 'step');
    expect(r.errors).toHaveLength(0);
  });

  it('step-level: allows extract in body', () => {
    const r = makeResult();
    validateLoopBody({ extract: {} }, 'ctx', r, 'step');
    expect(r.errors).toHaveLength(0);
  });

  it('step-level: allows match in body', () => {
    const r = makeResult();
    validateLoopBody({ match: {} }, 'ctx', r, 'step');
    expect(r.errors).toHaveLength(0);
  });

  it('step-level: rejects steps in body', () => {
    const r = makeResult();
    validateLoopBody({ steps: [] }, 'ctx', r, 'step');
    expect(
      r.errors.some((e) =>
        e.includes('"steps" is not allowed in a step-level loop body'),
      ),
    ).toBe(true);
  });

  // ── assertion-block level ──

  it('assertion-block-level: allows assertions in body', () => {
    const r = makeResult();
    validateLoopBody({ assertions: [] }, 'ctx', r, 'assertion-block');
    expect(r.errors).toHaveLength(0);
  });

  it('assertion-block-level: allows extract in body', () => {
    const r = makeResult();
    validateLoopBody({ extract: {} }, 'ctx', r, 'assertion-block');
    expect(r.errors).toHaveLength(0);
  });

  it('assertion-block-level: allows match in body', () => {
    const r = makeResult();
    validateLoopBody({ match: {} }, 'ctx', r, 'assertion-block');
    expect(r.errors).toHaveLength(0);
  });

  it('assertion-block-level: rejects action in body', () => {
    const r = makeResult();
    validateLoopBody({ action: {} }, 'ctx', r, 'assertion-block');
    expect(
      r.errors.some((e) =>
        e.includes(
          '"action" is not allowed in a assertion-block-level loop body',
        ),
      ),
    ).toBe(true);
  });

  it('assertion-block-level: rejects steps in body', () => {
    const r = makeResult();
    validateLoopBody({ steps: [] }, 'ctx', r, 'assertion-block');
    expect(
      r.errors.some((e) =>
        e.includes(
          '"steps" is not allowed in a assertion-block-level loop body',
        ),
      ),
    ).toBe(true);
  });

  // ── nested loops (tier drop) ──

  it('test-level: nested forEach drops to step level', () => {
    const r = makeResult();
    // Nested loop at test level should validate its body at step level,
    // so action is allowed but steps is not
    validateLoopBody(
      { forEach: { items: [], as: 'x', action: { type: 'wait' } } },
      'ctx',
      r,
      'test',
    );
    expect(r.errors).toHaveLength(0);
  });

  it('test-level: nested forEach rejects steps in nested body', () => {
    const r = makeResult();
    validateLoopBody(
      { forEach: { items: [], as: 'x', steps: [] } },
      'ctx',
      r,
      'test',
    );
    expect(
      r.errors.some((e) =>
        e.includes('"steps" is not allowed in a step-level loop body'),
      ),
    ).toBe(true);
  });

  it('step-level: nested for drops to assertion-block level', () => {
    const r = makeResult();
    // Nested loop at step level should validate body at assertion-block level,
    // so assertions is allowed but action is not
    validateLoopBody(
      { for: { from: 0, to: 5, as: 'i', assertions: [] } },
      'ctx',
      r,
      'step',
    );
    expect(r.errors).toHaveLength(0);
  });

  it('step-level: nested for rejects action in nested body', () => {
    const r = makeResult();
    validateLoopBody(
      { for: { from: 0, to: 5, as: 'i', action: {} } },
      'ctx',
      r,
      'step',
    );
    expect(
      r.errors.some((e) =>
        e.includes(
          '"action" is not allowed in a assertion-block-level loop body',
        ),
      ),
    ).toBe(true);
  });

  it('assertion-block-level: rejects nested loops entirely', () => {
    const r = makeResult();
    validateLoopBody(
      { forEach: { items: [], as: 'x' } },
      'ctx',
      r,
      'assertion-block',
    );
    expect(
      r.errors.some((e) =>
        e.includes(
          'nested loops are not allowed inside an assertion-block-level loop',
        ),
      ),
    ).toBe(true);
  });

  it('test-level: double-nested forEach (test → step → assertion-block)', () => {
    const r = makeResult();
    // test-level forEach with a nested forEach inside (step-level) that has assertions
    validateLoopBody(
      {
        forEach: {
          items: [],
          as: 'outer',
          forEach: { items: [], as: 'inner', assertions: [] },
        },
      },
      'ctx',
      r,
      'test',
    );
    expect(r.errors).toHaveLength(0);
  });

  it('test-level: triple nesting is rejected at assertion-block level', () => {
    const r = makeResult();
    validateLoopBody(
      {
        forEach: {
          items: [],
          as: 'a',
          forEach: {
            items: [],
            as: 'b',
            forEach: { items: [], as: 'c' },
          },
        },
      },
      'ctx',
      r,
      'test',
    );
    expect(
      r.errors.some((e) =>
        e.includes(
          'nested loops are not allowed inside an assertion-block-level loop',
        ),
      ),
    ).toBe(true);
  });
});

describe('validateLoopModifiers with level option', () => {
  it('defaults to step level when level not specified', () => {
    const r = makeResult();
    validateLoopModifiers(
      { forEach: { items: [], as: 'x', steps: [] } },
      'ctx',
      r,
    );
    // step is the default level, steps should be rejected
    expect(
      r.errors.some((e) =>
        e.includes('"steps" is not allowed in a step-level loop body'),
      ),
    ).toBe(true);
  });

  it('test level via options rejects action in loop body', () => {
    const r = makeResult();
    validateLoopModifiers(
      { forEach: { items: [], as: 'x', action: {} } },
      'ctx',
      r,
      { level: 'test' },
    );
    expect(
      r.errors.some((e) =>
        e.includes('"action" is not allowed in a test-level loop body'),
      ),
    ).toBe(true);
  });

  it('test level via options allows steps in loop body', () => {
    const r = makeResult();
    validateLoopModifiers(
      { forEach: { items: [], as: 'x', steps: [] } },
      'ctx',
      r,
      { level: 'test' },
    );
    expect(r.errors).toHaveLength(0);
  });

  it('assertion-block level via options allows assertions but rejects action', () => {
    const r = makeResult();
    validateLoopModifiers(
      {
        forEach: {
          items: '$.response.body',
          as: 'x',
          assertions: [],
          action: {},
        },
      },
      'ctx',
      r,
      { allowDocPaths: true, level: 'assertion-block' },
    );
    expect(
      r.errors.some((e) =>
        e.includes(
          '"action" is not allowed in a assertion-block-level loop body',
        ),
      ),
    ).toBe(true);
    // assertions should not cause an error
    expect(
      r.errors.some((e) => e.includes('"assertions" is not allowed')),
    ).toBe(false);
  });

  it('preserves allowDocPaths behavior alongside level', () => {
    const r = makeResult();
    validateLoopModifiers(
      { forEach: { items: '$.response.body', as: 'x', assertions: [] } },
      'ctx',
      r,
      { allowDocPaths: true, level: 'assertion-block' },
    );
    // No errors: $.path is allowed with allowDocPaths, and assertions is valid at assertion-block level
    expect(r.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Step-level loop + sibling conflicts
// ---------------------------------------------------------------------------

describe('validateLoopSiblingConflicts', () => {
  it('errors when step has assertions as sibling of forEach', () => {
    const r = makeResult();
    validateLoopSiblingConflicts(
      {
        forEach: { items: [], as: 'x' },
        assertions: [
          {
            assertions: [
              { path: '$.response.status', operator: 'eq', value: 200 },
            ],
          },
        ],
      },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('"assertions" must be inside "forEach" body');
  });

  it('errors when step has assertions as sibling of for', () => {
    const r = makeResult();
    validateLoopSiblingConflicts(
      {
        for: { from: 1, to: 3, as: 'i' },
        assertions: [{ assertions: [] }],
      },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('"assertions" must be inside "for" body');
  });

  it('errors when step has extract as sibling of for', () => {
    const r = makeResult();
    validateLoopSiblingConflicts(
      {
        for: { from: 1, to: 3, as: 'i', extract: { x: '$.response.body.x' } },
        extract: { y: '$.response.body.y' },
      },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('"extract" must be inside "for" body');
  });

  it('no error when no loop modifier present', () => {
    const r = makeResult();
    validateLoopSiblingConflicts(
      { assertions: [{ assertions: [] }], extract: { x: '$.y' } },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('no error when action is sibling of loop (step action used per iteration)', () => {
    const r = makeResult();
    validateLoopSiblingConflicts(
      {
        for: { from: 1, to: 3, as: 'i', assertions: [{ assertions: [] }] },
        action: { type: 'httpRequest', method: 'GET', url: 'svc/health' },
      },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('no error when assertions are inside the loop body', () => {
    const r = makeResult();
    validateLoopSiblingConflicts(
      {
        forEach: {
          items: [],
          as: 'x',
          assertions: [{ assertions: [] }],
        },
      },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });
});
