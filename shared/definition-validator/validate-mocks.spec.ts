import { validateDefinition } from './validate';
import { makeMockFs, makeResult } from './test-helpers';

function validateMock(
  mock: Record<string, unknown>,
  definition: Record<string, unknown> = {},
) {
  const r = makeResult();
  validateDefinition(
    {
      name: 'def',
      items: [
        { type: 'SERVICE', name: 'svc', image: 'i', port: 1, healthCheck: '/' },
        {
          type: 'SERVICE',
          name: 'my-svc',
          image: 'i',
          port: 1,
          healthCheck: '/',
        },
        { type: 'WORKER', name: 'wrk', image: 'i' },
        {
          type: 'MOCK',
          name: 'mock',
          mockTarget: 'api.example.com',
          mockPath: '/v1',
          ...mock,
        },
      ],
      ...definition,
    },
    '/f.yaml',
    r,
    makeMockFs({}),
  );
  return r;
}

describe('mock items', () => {
  it.each([
    { mockTarget: '*' },
    { mockTarget: 'api.example.com:8080' },
    { mockTarget: 'my_service' },
    { mockTarget: 'SVC' },
    { mockTarget: 'svc:80' },
    { mockTarget: '{{svc}}' },
    { mockTarget: '${{SVC}}:80' },
    { mockTarget: 'my.svc' },
    { mockTarget: '{{host}}' },
    { mockTarget: '${{HOST}}/x' },
    { mockPath: '*' },
    { mockPath: '/' },
    { mockPath: '/*' },
    { mockPath: '/api*' },
    { mockPath: '/users/{id}' },
    { mockPath: '/users/{id}/orders/:orderId' },
    { mockPath: '/a=b/{id}' },
    { mockPath: '/v1/projects:batch' },
    { mockPath: '{{path}}' },
    { mockOrigin: '*' },
    { mockOrigin: 'svc' },
    { mockOrigin: 'wrk' },
    { mockOrigin: 'chromium' },
    { mockOrigin: '{{caller}}' },
    { mockDelayMs: 0 },
    { mockResponseHeaders: { 'X-A': 'a', 'X-B': 5, 'Set-Cookie': ['a', 'b'] } },
  ])('accepts %j', (mock) => {
    expect(validateMock(mock).errors).toEqual([]);
  });

  it.each([
    [{ mockTarget: '*.example.com' }, '"*" only works on its own'],
    [{ mockTarget: 'https://api.example.com' }, 'use only a host'],
    [{ mockTarget: 'api.example.com/v1' }, 'use only a host'],
    [{ mockTarget: 'MY_SVC' }, `use the service's name, "my-svc"`],
    [{ mockTarget: 'my_svc:80' }, `use the service's name, "my-svc"`],
    [{ mockPath: 'v1' }, 'must start with "/"'],
    [{ mockPath: '/v1?x=1' }, 'query strings are ignored'],
    [{ mockPath: '/v1/*/x' }, '"*" only works at the end'],
    [{ mockPath: '/files/{name=**}' }, '"=" isn\'t supported in a variable'],
    [{ mockPath: '/files/:name=**' }, '"=" isn\'t supported in a variable'],
    [{ mockPath: '/files/{name*}' }, '"*" only works at the end'],
    [{ mockPath: '/v1/**' }, '"*" only works at the end'],
    [{ mockPath: '/file.{ext}' }, 'must be a whole segment'],
    [{ mockPath: '/users/{}' }, 'must be a whole segment'],
    [{ mockPath: '/users/{id}/*' }, "can't be combined"],
    [{ mockPath: '/users/:id/*' }, "can't be combined"],
    [{ mockOrigin: 'svcc' }, 'not the name of a SERVICE or WORKER'],
    [{ mockOrigin: 'mock' }, 'not the name of a SERVICE or WORKER'],
    [{ mockOrigin: 5 }, 'mockOrigin must be a string'],
    [{ mockDelayMs: 1.5 }, 'non-negative integer'],
    [{ mockDelayMs: -1 }, 'non-negative integer'],
    [{ mockResponseHeaders: ['a'] }, 'must be an object'],
    [{ mockResponseHeaders: { 'X-A': { b: 1 } } }, 'must be an object'],
  ])('rejects %j', (mock, message) => {
    expect(validateMock(mock).errors).toEqual([
      expect.stringContaining(message),
    ]);
  });

  it('rejects a top-level mocks array', () => {
    const r = validateMock({}, { mocks: [{ target: 'a.com', path: '/' }] });
    expect(r.errors).toEqual([expect.stringContaining('"type": "MOCK"')]);
    expect(r.warnings).toEqual([]);
  });

  const everything = { mockTarget: '*', mockPath: '*' };

  it.each([everything, { ...everything, mockPath: '/*', mockMethod: '*' }])(
    'warns that %j replaces every service',
    (mock) => {
      expect(validateMock(mock).warnings).toEqual([
        expect.stringContaining('replaces all your services'),
      ]);
    },
  );

  it.each([
    { mockMethod: 'GET' },
    { mockOrigin: 'svc' },
    { mockPath: '/x' },
    { mockTarget: 'a.com' },
    { mockRequestBodyContains: 'x' },
    { mockRequestBodyMatches: 'x' },
  ])('does not warn with %j', (mock) => {
    expect(validateMock({ ...everything, ...mock }).warnings).toEqual([]);
  });
});
