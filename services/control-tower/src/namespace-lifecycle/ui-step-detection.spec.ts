import { hasUiSteps } from './ui-step-detection';
import { DeployableDefinition } from './deployment-context.types';

function def(tests: DeployableDefinition['tests']): DeployableDefinition {
  return { name: 'x', items: [], tests };
}

describe('hasUiSteps', () => {
  it('returns false when tests is undefined', () => {
    expect(hasUiSteps(def(undefined))).toBe(false);
  });

  it('returns false when tests array is empty', () => {
    expect(hasUiSteps(def([]))).toBe(false);
  });

  it('returns false for API-only tests', () => {
    const d = def([
      {
        name: 't',
        steps: [
          {
            action: { type: 'httpRequest', method: 'GET', url: '/a' },
          } as any,
        ],
      },
    ]);
    expect(hasUiSteps(d)).toBe(false);
  });

  it('returns false for dbQuery-only tests', () => {
    const d = def([
      {
        name: 't',
        steps: [
          {
            action: { type: 'dbQuery', database: 'pg', query: 'SELECT 1' },
          } as any,
        ],
      },
    ]);
    expect(hasUiSteps(d)).toBe(false);
  });

  it('returns true when any step has action.type === "ui"', () => {
    const d = def([
      {
        name: 't',
        steps: [
          {
            action: { type: 'httpRequest', method: 'GET', url: '/a' },
          } as any,
          {
            action: { type: 'dbQuery', database: 'pg', query: 'SELECT 1' },
          } as any,
          { action: { type: 'ui', target: 'frontend', steps: [] } } as any,
        ],
      },
    ]);
    expect(hasUiSteps(d)).toBe(true);
  });

  it('finds UI steps across multiple tests', () => {
    const d = def([
      {
        name: 'api-test',
        steps: [
          {
            action: { type: 'httpRequest', method: 'GET', url: '/a' },
          } as any,
        ],
      },
      {
        name: 'ui-test',
        steps: [
          { action: { type: 'ui', target: 'frontend', steps: [] } } as any,
        ],
      },
    ]);
    expect(hasUiSteps(d)).toBe(true);
  });

  it('tolerates malformed steps without throwing', () => {
    const d = def([{ name: 't', steps: [null as any, undefined as any] }]);
    expect(hasUiSteps(d)).toBe(false);
  });
});
