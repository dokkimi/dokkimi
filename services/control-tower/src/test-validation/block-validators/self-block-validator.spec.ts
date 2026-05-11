import { validateSelfBlock } from './self-block-validator';
import { AssertionBlock, Assertion } from '@dokkimi/config';

function makeBlock(assertions: Partial<Assertion>[]): AssertionBlock {
  return {
    assertions: assertions.map((a) => ({
      path: a.path ?? 'response.status',
      operator: a.operator ?? 'eq',
      value: a.value ?? 200,
      disabled: a.disabled,
    })) as Assertion[],
  } as AssertionBlock;
}

describe('validateSelfBlock', () => {
  it('returns failure for all assertions when stepDoc is empty', () => {
    const block = makeBlock([
      { path: 'response.status', operator: 'eq', value: 200 },
      { path: 'response.body.name', operator: 'eq', value: 'Alice' },
    ]);
    const results = validateSelfBlock(block, {});
    expect(results).toHaveLength(2);
    expect(results[0].passed).toBe(false);
    expect(results[0].error).toBe('Step log not found');
    expect(results[0].path).toBe('response.status');
    expect(results[1].passed).toBe(false);
    expect(results[1].error).toBe('Step log not found');
  });

  it('validates assertions against the step document', () => {
    const block = makeBlock([
      { path: 'response.status', operator: 'eq', value: 200 },
    ]);
    const doc = { response: { status: 200 } };
    const results = validateSelfBlock(block, doc);
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    expect(results[0].resultKind).toBe('field');
  });

  it('skips disabled assertions', () => {
    const block = makeBlock([
      { path: 'response.status', operator: 'eq', value: 200, disabled: true },
      { path: 'response.status', operator: 'eq', value: 200 },
    ]);
    const doc = { response: { status: 200 } };
    const results = validateSelfBlock(block, doc);
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
  });

  it('sets path and operator on results', () => {
    const block = makeBlock([
      { path: 'response.body.name', operator: 'contains', value: 'ali' },
    ]);
    const doc = { response: { body: { name: 'Alice' } } };
    const results = validateSelfBlock(block, doc);
    expect(results[0].path).toBe('response.body.name');
    expect(results[0].operator).toBe('contains');
  });

  it('returns failure result for failing assertion', () => {
    const block = makeBlock([
      { path: 'response.status', operator: 'eq', value: 404 },
    ]);
    const doc = { response: { status: 200 } };
    const results = validateSelfBlock(block, doc);
    expect(results[0].passed).toBe(false);
    expect(results[0].expected).toBe(404);
    expect(results[0].actual).toBe(200);
  });

  it('handles multiple assertions with mixed results', () => {
    const block = makeBlock([
      { path: 'response.status', operator: 'eq', value: 200 },
      { path: 'response.status', operator: 'eq', value: 404 },
    ]);
    const doc = { response: { status: 200 } };
    const results = validateSelfBlock(block, doc);
    expect(results).toHaveLength(2);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(false);
  });
});
