import type { ResolvedDefinition } from '@dokkimi/definition-resolver';
import { trackEvent } from '@dokkimi/telemetry';
import { fetchPostWithError } from '../lib/cli-utils';

jest.mock('@dokkimi/telemetry', () => ({
  trackEvent: jest.fn(),
}));

jest.mock('../lib/cli-utils', () => ({
  fetchPostWithError: jest.fn(),
}));

import {
  definitionHasUiSteps,
  detectTargetType,
  trackRunError,
  buildSubmitBody,
  submitDefinition,
} from './run-helpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDef(
  overrides: Partial<ResolvedDefinition> & {
    definition?: Record<string, unknown>;
    initFiles?: ResolvedDefinition['initFiles'];
  } = {},
): ResolvedDefinition {
  return {
    name: 'test',
    sourceFile: 'test.yaml',
    definition: { items: [], tests: [], ...overrides.definition },
    initFiles: overrides.initFiles ?? [],
    ...overrides,
  } as ResolvedDefinition;
}

// ---------------------------------------------------------------------------
// definitionHasUiSteps
// ---------------------------------------------------------------------------

describe('definitionHasUiSteps', () => {
  it('returns true when definition has a UI action step', () => {
    const def = makeDef({
      definition: {
        items: [],
        tests: [
          {
            name: 'ui-test',
            steps: [{ action: { type: 'ui', command: 'click' } }],
          },
        ],
      },
    });
    expect(definitionHasUiSteps(def)).toBe(true);
  });

  it('returns false when no tests', () => {
    const def = makeDef({ definition: { items: [] } });
    expect(definitionHasUiSteps(def)).toBe(false);
  });

  it('returns false when tests have no UI steps', () => {
    const def = makeDef({
      definition: {
        items: [],
        tests: [
          {
            name: 'http-test',
            steps: [{ action: { type: 'httpCall', url: '/api' } }],
          },
        ],
      },
    });
    expect(definitionHasUiSteps(def)).toBe(false);
  });

  it('returns false when steps array is missing', () => {
    const def = makeDef({
      definition: {
        items: [],
        tests: [{ name: 'no-steps' }],
      },
    });
    expect(definitionHasUiSteps(def)).toBe(false);
  });

  it('handles empty steps array', () => {
    const def = makeDef({
      definition: {
        items: [],
        tests: [{ name: 'empty-steps', steps: [] }],
      },
    });
    expect(definitionHasUiSteps(def)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectTargetType
// ---------------------------------------------------------------------------

describe('detectTargetType', () => {
  it('returns "none" for undefined', () => {
    expect(detectTargetType(undefined)).toBe('none');
  });

  it('returns "directory" for existing directory', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs');
    const origExistsSync = fs.existsSync;
    const origStatSync = fs.statSync;

    fs.existsSync = jest.fn().mockReturnValue(true);
    fs.statSync = jest.fn().mockReturnValue({ isDirectory: () => true });

    expect(detectTargetType('/some/dir')).toBe('directory');

    fs.existsSync = origExistsSync;
    fs.statSync = origStatSync;
  });

  it('returns "file" for .json extension', () => {
    expect(detectTargetType('test.json')).toBe('file');
  });

  it('returns "file" for .yml extension', () => {
    expect(detectTargetType('test.yml')).toBe('file');
  });

  it('returns "file" for .yaml extension', () => {
    expect(detectTargetType('test.yaml')).toBe('file');
  });

  it('returns "pattern" for other strings', () => {
    expect(detectTargetType('my-service*')).toBe('pattern');
  });
});

// ---------------------------------------------------------------------------
// trackRunError
// ---------------------------------------------------------------------------

describe('trackRunError', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const cases: Array<[string, string, Record<string, unknown> | undefined]> = [
    ['Docker is not installed', 'docker_not_installed', undefined],
    ['Timed out waiting for Docker', 'docker_start_timeout', undefined],
    [
      'Timed out waiting for Dokkimi',
      'service_start_timeout',
      { failed_services: ['dokkimi'] },
    ],
    ['daemon.lock is held', 'daemon_lock_timeout', undefined],
    ['something completely unknown', 'unknown', undefined],
  ];

  it.each(cases)(
    'calls trackEvent with correct type for "%s"',
    (
      message: string,
      expectedType: string,
      extraProps: Record<string, unknown> | undefined,
    ) => {
      trackRunError(new Error(message));
      expect(trackEvent).toHaveBeenCalledWith('cli_service_error', {
        error_type: expectedType,
        ...(extraProps ?? {}),
      });
    },
  );
});

// ---------------------------------------------------------------------------
// buildSubmitBody
// ---------------------------------------------------------------------------

describe('buildSubmitBody', () => {
  it('strips initFilePath/initFilePaths from items', () => {
    const def = makeDef({
      definition: {
        items: [
          { name: 'svc', type: 'service', initFilePath: '/path/to/init.sql' },
        ],
        tests: [],
      },
    });
    const body = buildSubmitBody(def);
    const items = (body.definition as Record<string, unknown>).items as Array<
      Record<string, unknown>
    >;
    expect(items[0]).not.toHaveProperty('initFilePath');
    expect(items[0]).not.toHaveProperty('initFilePaths');
    expect(items[0].name).toBe('svc');
  });

  it('attaches base64-encoded init files to matching items', () => {
    const def = makeDef({
      definition: {
        items: [{ name: 'db', type: 'database' }],
        tests: [],
      },
      initFiles: [
        {
          itemName: 'db',
          filename: 'init.sql',
          content: Buffer.from('CREATE TABLE t(id int);'),
        },
      ],
    });
    const body = buildSubmitBody(def);
    const items = (body.definition as Record<string, unknown>).items as Array<
      Record<string, unknown>
    >;
    expect(items[0].initFiles).toEqual([
      {
        filename: 'init.sql',
        content: Buffer.from('CREATE TABLE t(id int);').toString('base64'),
      },
    ]);
  });

  it('converts array env to object env', () => {
    const def = makeDef({
      definition: {
        items: [
          {
            name: 'svc',
            type: 'service',
            env: [
              { name: 'FOO', value: 'bar' },
              { name: 'BAZ', value: 'qux' },
            ],
          },
        ],
        tests: [],
      },
    });
    const body = buildSubmitBody(def);
    const items = (body.definition as Record<string, unknown>).items as Array<
      Record<string, unknown>
    >;
    expect(items[0].env).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('preserves items without init files unchanged', () => {
    const def = makeDef({
      definition: {
        items: [{ name: 'svc', type: 'service', image: 'node:18' }],
        tests: [],
      },
    });
    const body = buildSubmitBody(def);
    const items = (body.definition as Record<string, unknown>).items as Array<
      Record<string, unknown>
    >;
    expect(items[0]).toEqual({
      name: 'svc',
      type: 'service',
      image: 'node:18',
    });
  });
});

// ---------------------------------------------------------------------------
// submitDefinition
// ---------------------------------------------------------------------------

describe('submitDefinition', () => {
  const mockFetchPost = fetchPostWithError as jest.MockedFunction<
    typeof fetchPostWithError
  >;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls fetchPostWithError with correct URL and body', async () => {
    mockFetchPost.mockResolvedValue({ data: {} as never });
    const def = makeDef({
      definition: { items: [], tests: [] },
    });

    await submitDefinition('http://localhost:19001', 'run-1', 'inst-1', def);

    expect(mockFetchPost).toHaveBeenCalledWith(
      'http://localhost:19001/runs/run-1/instances/inst-1',
      expect.objectContaining({ definition: expect.any(Object) }),
    );
  });

  it('returns null on success', async () => {
    mockFetchPost.mockResolvedValue({ data: {} as never });
    const def = makeDef();
    const result = await submitDefinition(
      'http://localhost:19001',
      'run-1',
      'inst-1',
      def,
    );
    expect(result).toBeNull();
  });

  it('returns error string on failure', async () => {
    mockFetchPost.mockResolvedValue({ error: 'Bad request' });
    const def = makeDef();
    const result = await submitDefinition(
      'http://localhost:19001',
      'run-1',
      'inst-1',
      def,
    );
    expect(result).toBe('Bad request');
  });
});
