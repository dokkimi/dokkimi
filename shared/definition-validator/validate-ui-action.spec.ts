import { validateStep } from './validate-tests';
import { validateUiAction } from './validate-ui-action';
import { makeResult } from './test-helpers';

// ---------------------------------------------------------------------------
// validateUiAction — shape-level (target + steps array)
// ---------------------------------------------------------------------------

describe('validateUiAction', () => {
  it('accepts a minimal valid ui action', () => {
    const r = makeResult();
    validateUiAction(
      {
        type: 'ui',
        target: 'frontend-svc',
        steps: [{ visit: '/' }],
      },
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('errors on missing target', () => {
    const r = makeResult();
    validateUiAction({ type: 'ui', steps: [] }, 'ctx', r);
    expect(r.errors.some((e) => e.includes('non-empty "target"'))).toBe(true);
  });

  it('errors when target is empty string', () => {
    const r = makeResult();
    validateUiAction({ type: 'ui', target: '', steps: [] }, 'ctx', r);
    expect(r.errors.some((e) => e.includes('non-empty "target"'))).toBe(true);
  });

  it('errors on missing steps', () => {
    const r = makeResult();
    validateUiAction({ type: 'ui', target: 'svc' }, 'ctx', r);
    expect(r.errors.some((e) => e.includes('requires "steps" array'))).toBe(
      true,
    );
  });

  it('errors when steps is not an array', () => {
    const r = makeResult();
    validateUiAction(
      { type: 'ui', target: 'svc', steps: 'nope' as unknown },
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('"steps" must be an array'))).toBe(
      true,
    );
  });

  it('warns on empty steps array', () => {
    const r = makeResult();
    validateUiAction({ type: 'ui', target: 'svc', steps: [] }, 'ctx', r);
    expect(r.errors).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes('empty'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sub-step dispatch — each kind via the public validateStep entry point
// ---------------------------------------------------------------------------

function stepWith(subSteps: unknown[]) {
  return {
    action: { type: 'ui', target: 'svc', steps: subSteps },
  };
}

describe('ui sub-step dispatch', () => {
  it('errors when sub-step has no kind key', () => {
    const r = makeResult();
    validateStep(stepWith([{}]), 'ctx', r);
    expect(r.errors.some((e) => e.includes('missing sub-step kind'))).toBe(
      true,
    );
  });

  it('errors when sub-step has multiple kind keys', () => {
    const r = makeResult();
    validateStep(stepWith([{ visit: '/', click: '[data-x]' }]), 'ctx', r);
    expect(r.errors.some((e) => e.includes('multiple kind keys'))).toBe(true);
  });

  it('warns on unknown auxiliary keys next to a valid kind', () => {
    const r = makeResult();
    validateStep(stepWith([{ visit: '/', bogus: true }]), 'ctx', r);
    expect(r.warnings.some((w) => w.includes('unknown sub-step key'))).toBe(
      true,
    );
  });

  it('errors when sub-step is not an object', () => {
    const r = makeResult();
    validateStep(stepWith(['not-an-object']), 'ctx', r);
    expect(r.errors.some((e) => e.includes('must be an object'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Per-sub-step timeoutMs override
// ---------------------------------------------------------------------------

describe('ui sub-step timeoutMs', () => {
  it('accepts a positive integer timeoutMs alongside the kind', () => {
    const r = makeResult();
    validateStep(stepWith([{ click: '[data-x]', timeoutMs: 5000 }]), 'ctx', r);
    expect(r.errors).toHaveLength(0);
    expect(
      r.warnings.some((w) => w.includes('unknown sub-step key "timeoutMs"')),
    ).toBe(false);
  });

  it('errors when timeoutMs is zero', () => {
    const r = makeResult();
    validateStep(stepWith([{ click: '[data-x]', timeoutMs: 0 }]), 'ctx', r);
    expect(
      r.errors.some((e) => e.includes('timeoutMs') && e.includes('positive')),
    ).toBe(true);
  });

  it('errors when timeoutMs is negative', () => {
    const r = makeResult();
    validateStep(stepWith([{ click: '[data-x]', timeoutMs: -1 }]), 'ctx', r);
    expect(
      r.errors.some((e) => e.includes('timeoutMs') && e.includes('positive')),
    ).toBe(true);
  });

  it('errors when timeoutMs is a non-integer', () => {
    const r = makeResult();
    validateStep(stepWith([{ click: '[data-x]', timeoutMs: 1.5 }]), 'ctx', r);
    expect(r.errors.some((e) => e.includes('timeoutMs'))).toBe(true);
  });

  it('errors when timeoutMs is a string', () => {
    const r = makeResult();
    validateStep(
      stepWith([{ click: '[data-x]', timeoutMs: '5000' }]),
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('timeoutMs'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Per-kind validation
// ---------------------------------------------------------------------------

describe('visit sub-step', () => {
  it('accepts a valid visit', () => {
    const r = makeResult();
    validateStep(stepWith([{ visit: '/login' }]), 'ctx', r);
    expect(r.errors).toHaveLength(0);
  });

  it('errors on empty string', () => {
    const r = makeResult();
    validateStep(stepWith([{ visit: '' }]), 'ctx', r);
    expect(r.errors.some((e) => e.includes('visit'))).toBe(true);
  });

  it('errors on non-string', () => {
    const r = makeResult();
    validateStep(stepWith([{ visit: 42 }]), 'ctx', r);
    expect(r.errors.some((e) => e.includes('visit'))).toBe(true);
  });
});

describe('click sub-step', () => {
  it('accepts a valid click', () => {
    const r = makeResult();
    validateStep(stepWith([{ click: "[data-testid='x']" }]), 'ctx', r);
    expect(r.errors).toHaveLength(0);
  });

  it('errors on empty selector', () => {
    const r = makeResult();
    validateStep(stepWith([{ click: '' }]), 'ctx', r);
    expect(r.errors.some((e) => e.includes('click'))).toBe(true);
  });
});

describe('type sub-step', () => {
  it('accepts a valid type', () => {
    const r = makeResult();
    validateStep(
      stepWith([{ type: { selector: '#email', text: 'a@b.c' } }]),
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('errors on missing selector', () => {
    const r = makeResult();
    validateStep(stepWith([{ type: { text: 'x' } }]), 'ctx', r);
    expect(
      r.errors.some((e) => e.includes('type: requires non-empty "selector"')),
    ).toBe(true);
  });

  it('errors on missing text', () => {
    const r = makeResult();
    validateStep(stepWith([{ type: { selector: '#a' } }]), 'ctx', r);
    expect(r.errors.some((e) => e.includes('type: requires "text"'))).toBe(
      true,
    );
  });

  it('errors when type value is not an object', () => {
    const r = makeResult();
    validateStep(stepWith([{ type: 'oops' }]), 'ctx', r);
    expect(
      r.errors.some((e) => e.includes('must be an object { selector, text }')),
    ).toBe(true);
  });

  it('warns on unknown keys inside type value', () => {
    const r = makeResult();
    validateStep(
      stepWith([{ type: { selector: '#a', text: 'x', extra: 1 } }]),
      'ctx',
      r,
    );
    expect(r.warnings.some((w) => w.includes('unknown property "extra"'))).toBe(
      true,
    );
  });
});

describe('waitFor sub-step', () => {
  it('accepts a selector string', () => {
    const r = makeResult();
    validateStep(
      stepWith([{ waitFor: "[data-testid='dashboard']" }]),
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('accepts an object with selector + text', () => {
    const r = makeResult();
    validateStep(
      stepWith([{ waitFor: { selector: '[data-x]', text: '1' } }]),
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('accepts an object with just selector', () => {
    const r = makeResult();
    validateStep(stepWith([{ waitFor: { selector: '[data-x]' } }]), 'ctx', r);
    expect(r.errors).toHaveLength(0);
  });

  it('errors on empty selector string', () => {
    const r = makeResult();
    validateStep(stepWith([{ waitFor: '' }]), 'ctx', r);
    expect(
      r.errors.some((e) => e.includes('selector string must not be empty')),
    ).toBe(true);
  });

  it('errors when object missing selector', () => {
    const r = makeResult();
    validateStep(stepWith([{ waitFor: { text: 'x' } }]), 'ctx', r);
    expect(
      r.errors.some((e) => e.includes('requires non-empty "selector"')),
    ).toBe(true);
  });

  it('errors when object text is not a string', () => {
    const r = makeResult();
    validateStep(
      stepWith([{ waitFor: { selector: '#x', text: 42 } }]),
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('"text" must be a string'))).toBe(
      true,
    );
  });

  it('errors when value is neither string nor object', () => {
    const r = makeResult();
    validateStep(stepWith([{ waitFor: 42 }]), 'ctx', r);
    expect(
      r.errors.some((e) => e.includes('selector string or an object')),
    ).toBe(true);
  });
});

describe('screenshot sub-step', () => {
  it('accepts a valid screenshot', () => {
    const r = makeResult();
    validateStep(stepWith([{ screenshot: 'checkout-confirmation' }]), 'ctx', r);
    expect(r.errors).toHaveLength(0);
  });

  it('errors on empty name', () => {
    const r = makeResult();
    validateStep(stepWith([{ screenshot: '' }]), 'ctx', r);
    expect(r.errors.some((e) => e.includes('screenshot'))).toBe(true);
  });

  it('rejects names containing path separators (path-traversal guard)', () => {
    const r = makeResult();
    validateStep(stepWith([{ screenshot: '../etc/passwd' }]), 'ctx', r);
    expect(r.errors.some((e) => e.includes('[a-zA-Z0-9_-]'))).toBe(true);
  });

  it('rejects names with spaces or special characters', () => {
    const r = makeResult();
    validateStep(stepWith([{ screenshot: 'checkout page!' }]), 'ctx', r);
    expect(r.errors.some((e) => e.includes('[a-zA-Z0-9_-]'))).toBe(true);
  });

  it('rejects names over 64 chars', () => {
    const r = makeResult();
    const longName = 'a'.repeat(65);
    validateStep(stepWith([{ screenshot: longName }]), 'ctx', r);
    expect(r.errors.some((e) => e.includes('[a-zA-Z0-9_-]'))).toBe(true);
  });

  it('accepts the boundary name lengths (1 char, 64 chars)', () => {
    const r = makeResult();
    validateStep(stepWith([{ screenshot: 'a' }]), 'ctx', r);
    validateStep(stepWith([{ screenshot: 'b'.repeat(64) }]), 'ctx', r);
    expect(r.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// screenshot sub-step — object form (with optional match block)
// ---------------------------------------------------------------------------

describe('screenshot sub-step — object form', () => {
  it('accepts a minimal object form with just a name', () => {
    const r = makeResult();
    validateStep(
      stepWith([{ screenshot: { name: 'checkout-page' } }]),
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('accepts the full object form (name + selector + match)', () => {
    const r = makeResult();
    validateStep(
      stepWith([
        {
          screenshot: {
            name: 'checkout',
            selector: '[data-testid="checkout"]',
            match: {
              threshold: 0.02,
              ignoreRegions: ['.timestamp', '.ad-slot'],
            },
          },
        },
      ]),
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('accepts match: true (boolean opt-in, defaults)', () => {
    const r = makeResult();
    validateStep(
      stepWith([{ screenshot: { name: 'page', match: true } }]),
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('accepts match: false (no diff — equivalent to omitting the key)', () => {
    const r = makeResult();
    validateStep(
      stepWith([{ screenshot: { name: 'page', match: false } }]),
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('accepts an empty match object (still valid; presence enables the diff)', () => {
    const r = makeResult();
    validateStep(
      stepWith([{ screenshot: { name: 'page', match: {} } }]),
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('errors when name is missing in object form', () => {
    const r = makeResult();
    validateStep(stepWith([{ screenshot: {} }]), 'ctx', r);
    expect(r.errors.some((e) => e.includes('screenshot.name'))).toBe(true);
  });

  it('errors when object-form name violates the artifact-name pattern', () => {
    const r = makeResult();
    validateStep(
      stepWith([{ screenshot: { name: '../etc/passwd' } }]),
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('[a-zA-Z0-9_-]'))).toBe(true);
  });

  it('errors when match.threshold is out of [0, 1]', () => {
    const r = makeResult();
    validateStep(
      stepWith([{ screenshot: { name: 'x', match: { threshold: 1.5 } } }]),
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('between 0 and 1'))).toBe(true);
  });

  it('errors when match.threshold is not a number', () => {
    const r = makeResult();
    validateStep(
      stepWith([{ screenshot: { name: 'x', match: { threshold: 'half' } } }]),
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('threshold'))).toBe(true);
  });

  it('errors when match.ignoreRegions contains a non-string entry', () => {
    const r = makeResult();
    validateStep(
      stepWith([
        { screenshot: { name: 'x', match: { ignoreRegions: ['.ts', 42] } } },
      ]),
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('ignoreRegions[1]'))).toBe(true);
  });

  it('errors when match is not a boolean or object', () => {
    const r = makeResult();
    validateStep(
      stepWith([{ screenshot: { name: 'x', match: 'on' } }]),
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('match'))).toBe(true);
  });

  it('errors when match is a number', () => {
    const r = makeResult();
    validateStep(stepWith([{ screenshot: { name: 'x', match: 1 } }]), 'ctx', r);
    expect(r.errors.some((e) => e.includes('match'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extract sub-step
// ---------------------------------------------------------------------------

describe('extract sub-step', () => {
  it('accepts a text extract', () => {
    const r = makeResult();
    validateStep(
      stepWith([{ extract: { orderId: { from: 'text', selector: 'h1' } } }]),
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('accepts an attribute extract', () => {
    const r = makeResult();
    validateStep(
      stepWith([
        {
          extract: {
            cartId: {
              from: 'attribute',
              selector: '[data-cart]',
              name: 'data-cart-id',
            },
          },
        },
      ]),
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('accepts a url extract with part', () => {
    const r = makeResult();
    validateStep(
      stepWith([{ extract: { path: { from: 'url', part: 'pathname' } } }]),
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('accepts a url extract with no part (default full)', () => {
    const r = makeResult();
    validateStep(stepWith([{ extract: { href: { from: 'url' } } }]), 'ctx', r);
    expect(r.errors).toHaveLength(0);
  });

  it('accepts cookie / localStorage / sessionStorage', () => {
    const r = makeResult();
    validateStep(
      stepWith([
        {
          extract: {
            sid: { from: 'cookie', name: 'sid' },
            draft: { from: 'localStorage', key: 'cart.draft' },
            flash: { from: 'sessionStorage', key: 'flash' },
          },
        },
      ]),
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('accepts count and exists with selector', () => {
    const r = makeResult();
    validateStep(
      stepWith([
        {
          extract: {
            itemCount: { from: 'count', selector: 'li.item' },
            hasCta: { from: 'exists', selector: '[data-cta]' },
          },
        },
      ]),
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('accepts regex pattern + group on a text extract', () => {
    const r = makeResult();
    validateStep(
      stepWith([
        {
          extract: {
            id: {
              from: 'text',
              selector: 'h1',
              pattern: 'Order #(\\S+)',
              group: 1,
            },
          },
        },
      ]),
      'ctx',
      r,
    );
    expect(r.errors).toHaveLength(0);
  });

  it('errors on invalid regex pattern', () => {
    const r = makeResult();
    validateStep(
      stepWith([
        {
          extract: {
            id: { from: 'text', selector: 'h1', pattern: '[unclosed' },
          },
        },
      ]),
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('not a valid regex'))).toBe(true);
  });

  it('warns when group is set without pattern', () => {
    const r = makeResult();
    validateStep(
      stepWith([
        {
          extract: {
            id: { from: 'text', selector: 'h1', group: 1 },
          },
        },
      ]),
      'ctx',
      r,
    );
    expect(
      r.warnings.some((w) =>
        w.includes('"group" has no effect without "pattern"'),
      ),
    ).toBe(true);
  });

  it('errors on unknown from value', () => {
    const r = makeResult();
    validateStep(
      stepWith([{ extract: { x: { from: 'bogus', selector: 'h1' } } }]),
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('invalid "from"'))).toBe(true);
  });

  it('errors on missing from', () => {
    const r = makeResult();
    validateStep(stepWith([{ extract: { x: { selector: 'h1' } } }]), 'ctx', r);
    expect(
      r.errors.some((e) => e.includes('missing "from" discriminator')),
    ).toBe(true);
  });

  it('errors when text extract is missing selector', () => {
    const r = makeResult();
    validateStep(stepWith([{ extract: { x: { from: 'text' } } }]), 'ctx', r);
    expect(
      r.errors.some((e) =>
        e.includes('from "text" requires non-empty "selector"'),
      ),
    ).toBe(true);
  });

  it('errors when attribute extract is missing name', () => {
    const r = makeResult();
    validateStep(
      stepWith([{ extract: { x: { from: 'attribute', selector: '#a' } } }]),
      'ctx',
      r,
    );
    expect(
      r.errors.some((e) =>
        e.includes('from "attribute" requires non-empty "name"'),
      ),
    ).toBe(true);
  });

  it('errors when cookie extract is missing name', () => {
    const r = makeResult();
    validateStep(stepWith([{ extract: { x: { from: 'cookie' } } }]), 'ctx', r);
    expect(
      r.errors.some((e) =>
        e.includes('from "cookie" requires non-empty "name"'),
      ),
    ).toBe(true);
  });

  it('errors when localStorage extract is missing key', () => {
    const r = makeResult();
    validateStep(
      stepWith([{ extract: { x: { from: 'localStorage' } } }]),
      'ctx',
      r,
    );
    expect(
      r.errors.some((e) =>
        e.includes('from "localStorage" requires non-empty "key"'),
      ),
    ).toBe(true);
  });

  it('errors on invalid url part', () => {
    const r = makeResult();
    validateStep(
      stepWith([{ extract: { x: { from: 'url', part: 'bogus' } } }]),
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('invalid "part"'))).toBe(true);
  });

  it('errors on non-alphanumeric variable name', () => {
    const r = makeResult();
    validateStep(
      stepWith([
        {
          extract: {
            'bad-name': { from: 'text', selector: 'h1' },
          },
        },
      ]),
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('must be alphanumeric'))).toBe(true);
  });

  it('warns when extract has no variables defined', () => {
    const r = makeResult();
    validateStep(stepWith([{ extract: {} }]), 'ctx', r);
    expect(r.warnings.some((w) => w.includes('no variables defined'))).toBe(
      true,
    );
  });

  it('errors when extract value is not an object', () => {
    const r = makeResult();
    validateStep(stepWith([{ extract: 'not-an-object' }]), 'ctx', r);
    expect(r.errors.some((e) => e.includes('must be an object'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Whole-action acceptance: the doc's worked checkout example must parse
// ---------------------------------------------------------------------------

describe('whole ui action — doc worked example', () => {
  it('accepts the checkout-e2e UI action shape', () => {
    const r = makeResult();
    validateStep(
      {
        action: {
          type: 'ui',
          target: 'frontend-svc',
          steps: [
            { visit: '/products/{{productSku}}' },
            { click: "[data-testid='add-to-cart']" },
            {
              waitFor: {
                selector: "[data-testid='cart-count']",
                text: '1',
              },
            },
            {
              extract: {
                cartId: {
                  selector: "[data-testid='cart-drawer']",
                  from: 'attribute',
                  name: 'data-cart-id',
                },
              },
            },
            { click: "[data-testid='checkout-btn']" },
            { waitFor: "[data-testid='order-confirmation']" },
            {
              extract: {
                orderId: {
                  selector: 'h1.order-heading',
                  from: 'text',
                  pattern: 'Order #(\\S+)',
                  group: 1,
                },
                orderTotal: {
                  selector: "[data-testid='order-total']",
                  from: 'text',
                  pattern: '\\$(\\d+\\.\\d{2})',
                  group: 1,
                },
              },
            },
            { screenshot: 'order-confirmation' },
          ],
        },
      },
      'ctx',
      r,
    );
    expect(r.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// scroll / select / hover / key / upload
// ---------------------------------------------------------------------------

describe('scroll sub-step', () => {
  it('accepts a string selector', () => {
    const r = makeResult();
    validateStep(stepWith([{ scroll: '[data-testid="footer"]' }]), 'ctx', r);
    expect(r.errors).toEqual([]);
  });

  it('accepts coordinate object', () => {
    const r = makeResult();
    validateStep(stepWith([{ scroll: { x: 0, y: 1000 } }]), 'ctx', r);
    expect(r.errors).toEqual([]);
  });

  it('errors when object form has neither selector nor coords', () => {
    const r = makeResult();
    validateStep(stepWith([{ scroll: {} }]), 'ctx', r);
    expect(
      r.errors.some((e) =>
        e.includes('needs "selector" or at least one of "x"/"y"'),
      ),
    ).toBe(true);
  });

  it('errors when y is non-integer', () => {
    const r = makeResult();
    validateStep(stepWith([{ scroll: { y: 100.5 } }]), 'ctx', r);
    expect(r.errors.some((e) => e.includes('scroll.y'))).toBe(true);
  });
});

describe('select sub-step', () => {
  it('accepts selector + value', () => {
    const r = makeResult();
    validateStep(
      stepWith([{ select: { selector: '#country', value: 'US' } }]),
      'ctx',
      r,
    );
    expect(r.errors).toEqual([]);
  });

  it('errors when selector is missing', () => {
    const r = makeResult();
    validateStep(stepWith([{ select: { value: 'US' } }]), 'ctx', r);
    expect(r.errors.some((e) => e.includes('select'))).toBe(true);
  });

  it('errors when value is missing', () => {
    const r = makeResult();
    validateStep(stepWith([{ select: { selector: '#country' } }]), 'ctx', r);
    expect(r.errors.some((e) => e.includes('select'))).toBe(true);
  });

  it('errors when value is not a string', () => {
    const r = makeResult();
    validateStep(
      stepWith([{ select: { selector: '#country', value: 42 } }]),
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('"value" string'))).toBe(true);
  });
});

describe('hover sub-step', () => {
  it('accepts a non-empty selector string', () => {
    const r = makeResult();
    validateStep(stepWith([{ hover: '[data-testid="menu"]' }]), 'ctx', r);
    expect(r.errors).toEqual([]);
  });

  it('errors when selector is empty', () => {
    const r = makeResult();
    validateStep(stepWith([{ hover: '' }]), 'ctx', r);
    expect(r.errors.some((e) => e.includes('hover'))).toBe(true);
  });
});

describe('key sub-step', () => {
  it('accepts a string key name', () => {
    const r = makeResult();
    validateStep(stepWith([{ key: 'Enter' }]), 'ctx', r);
    expect(r.errors).toEqual([]);
  });

  it('accepts an object with selector + key', () => {
    const r = makeResult();
    validateStep(
      stepWith([{ key: { selector: '#search', key: 'Enter' } }]),
      'ctx',
      r,
    );
    expect(r.errors).toEqual([]);
  });

  it('errors when key string is empty', () => {
    const r = makeResult();
    validateStep(stepWith([{ key: '' }]), 'ctx', r);
    expect(r.errors.some((e) => e.includes('key'))).toBe(true);
  });

  it('errors when object form is missing key', () => {
    const r = makeResult();
    validateStep(stepWith([{ key: { selector: '#search' } }]), 'ctx', r);
    expect(r.errors.some((e) => e.includes('"key" string'))).toBe(true);
  });
});

describe('upload sub-step', () => {
  it('accepts selector + non-empty files array', () => {
    const r = makeResult();
    validateStep(
      stepWith([
        {
          upload: {
            selector: 'input[type="file"]',
            files: ['/tmp/avatar.png'],
          },
        },
      ]),
      'ctx',
      r,
    );
    expect(r.errors).toEqual([]);
  });

  it('errors when files array is empty', () => {
    const r = makeResult();
    validateStep(
      stepWith([{ upload: { selector: 'input[type="file"]', files: [] } }]),
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('non-empty array'))).toBe(true);
  });

  it('errors when a file entry is not a string', () => {
    const r = makeResult();
    validateStep(
      stepWith([
        {
          upload: {
            selector: 'input[type="file"]',
            files: ['ok.png', 42],
          },
        },
      ]),
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('upload.files[1]'))).toBe(true);
  });
});

describe('drag sub-step', () => {
  it('accepts from + to selectors', () => {
    const r = makeResult();
    validateStep(
      stepWith([
        {
          drag: {
            from: "[data-testid='item-a']",
            to: "[data-testid='dropzone']",
          },
        },
      ]),
      'ctx',
      r,
    );
    expect(r.errors).toEqual([]);
  });

  it('errors when from is missing', () => {
    const r = makeResult();
    validateStep(
      stepWith([{ drag: { to: "[data-testid='dropzone']" } }]),
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('"from"'))).toBe(true);
  });

  it('errors when to is missing', () => {
    const r = makeResult();
    validateStep(
      stepWith([{ drag: { from: "[data-testid='item-a']" } }]),
      'ctx',
      r,
    );
    expect(r.errors.some((e) => e.includes('"to"'))).toBe(true);
  });

  it('errors when payload is not an object', () => {
    const r = makeResult();
    validateStep(stepWith([{ drag: 'item-to-zone' }]), 'ctx', r);
    expect(r.errors.some((e) => e.includes('drag'))).toBe(true);
  });
});
