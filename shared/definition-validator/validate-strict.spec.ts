import { validateDefinition } from './validate';
import { makeMockFs, makeResult, ONE_TEST } from './test-helpers';

// Mistakes that used to pass validation and then did nothing, matched
// everything, or crashed the test agent.

const SVC = {
  type: 'SERVICE',
  name: 'api',
  image: 'x:1',
  port: 80,
  healthCheck: '/h',
};

function errorsFor(def: Record<string, unknown>): string[] {
  const r = makeResult();
  validateDefinition(
    { name: 'd', items: [SVC], ...def },
    '/f.json',
    r,
    makeMockFs(),
  );
  return r.errors;
}

const step = (s: Record<string, unknown>) => ({
  tests: [{ name: 't', steps: [s] }],
});
const get = { type: 'httpRequest', method: 'GET', url: 'api/x' };

describe('a definition', () => {
  it('needs tests', () => {
    expect(errorsFor({})).toEqual(['a definition needs "tests"']);
    expect(errorsFor({ tests: [] })).toEqual([
      'a definition needs at least one test',
    ]);
  });

  it('may have $schema, for editors', () => {
    expect(
      errorsFor({ $schema: './dokkimi.schema.json', tests: ONE_TEST }),
    ).toEqual([]);
  });

  it.each(['HTTP_REQUEST', 'DB_QUERY'])('rejects %s items', (type) => {
    // Control Tower never accepted them
    expect(
      errorsFor({ items: [SVC, { type, name: 'r' }], tests: ONE_TEST }),
    ).toEqual([
      'items[1]: "type" must be one of: SERVICE, WORKER, DATABASE, BROKER, MOCK',
    ]);
  });
});

describe('unknown keys are errors', () => {
  it('in a match, so a misspelled "where" no longer matches everything', () => {
    const errors = errorsFor(
      step({
        action: get,
        assertions: [{ match: { path: '$.traffic', filter: [] } }],
      }),
    );
    expect(errors).toContain(
      'tests[0].steps[0].assertions[0].match: unknown property "filter"',
    );
  });

  it('for an action type', () => {
    expect(errorsFor(step({ action: { type: 'httprequest' } }))).toEqual([
      'tests[0].steps[0].action: unknown action type "httprequest" — expected httpRequest, dbQuery, wait, ui or parallel',
    ]);
  });
});

describe('an assertion block', () => {
  it('that is a bare assertion explains where it goes', () => {
    const errors = errorsFor(
      step({
        action: get,
        assertions: [{ path: '$.response.status', operator: 'eq', value: 200 }],
      }),
    );
    expect(errors).toContain(
      `tests[0].steps[0].assertions[0]: an assertion must be inside a block's "assertions" list: { assertions: [ { path, operator, value } ] }`,
    );
  });

  it('that checks nothing is rejected', () => {
    expect(
      errorsFor(step({ action: get, assertions: [{ assertions: [] }] })),
    ).toEqual([
      'tests[0].steps[0].assertions[0]: block checks nothing — give it "assertions", "match" or "extract"',
    ]);
  });
});

describe('field types', () => {
  it.each([
    [{ name: 2024, action: get }, 'tests[0].steps[0]: "name" must be a string'],
    [
      { action: { ...get, headers: { 'X-Id': 123 } } },
      'tests[0].steps[0].action.headers: "X-Id" must be a string — quote it: "123"',
    ],
    [
      { action: { type: 'dbQuery', database: 'db', query: 'q', params: [1] } },
      'tests[0].steps[0].action: "params" must be an object',
    ],
    [
      { action: get, stopOnFailure: 'no' },
      'tests[0].steps[0]: "stopOnFailure" must be a boolean',
    ],
  ])('%j', (s, message) => {
    expect(errorsFor(step(s))).toContain(message);
  });
});

it('a screenshot name is unique within a definition, not only a test', () => {
  const ui = {
    action: {
      type: 'ui',
      target: 'api',
      steps: [{ screenshot: { name: 'home', match: true } }],
    },
  };
  const errors = errorsFor({
    tests: [
      { name: 't1', steps: [ui] },
      { name: 't2', steps: [ui] },
    ],
  });
  expect(errors).toEqual([
    'tests[1].steps[0].action.steps[0]: duplicate screenshot name "home" — also used at tests[0].steps[0].action.steps[0]. Each screenshot name must be unique within a definition (screenshots are stored as screenshot/<name>.png and would overwrite each other).',
  ]);
});

it('a parallel sub-action has no loop: it runs once', () => {
  const errors = errorsFor(
    step({
      action: {
        type: 'parallel',
        actions: [{ ...get, repeat: { count: 5, as: 'i' } }, get],
      },
    }),
  );
  expect(errors).toContain(
    `tests[0].steps[0].action.actions[0]: "repeat" can't be used inside parallel — loop the step instead`,
  );
});
