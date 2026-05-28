jest.mock('@dokkimi/config', () => ({
  loadConfig: () => ({
    services: { controlTower: { host: 'localhost', port: 19001 } },
  }),
  buildServiceUrl: () => 'http://localhost:19001',
}));

const mockFetch = jest.fn();
(globalThis as any).fetch = mockFetch;

// Re-import after mocks are set up — the module caches the CT URL on first call.
let ctFetch: typeof import('./ct-client').ctFetch;
let ctFetchOrNull: typeof import('./ct-client').ctFetchOrNull;

beforeEach(async () => {
  jest.resetModules();
  (globalThis as any).fetch = mockFetch;
  jest.mock('@dokkimi/config', () => ({
    loadConfig: () => ({
      services: { controlTower: { host: 'localhost', port: 19001 } },
    }),
    buildServiceUrl: () => 'http://localhost:19001',
  }));
  const mod = await import('./ct-client');
  ctFetch = mod.ctFetch;
  ctFetchOrNull = mod.ctFetchOrNull;
  mockFetch.mockReset();
});

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

describe('ctFetch', () => {
  it('fetches JSON from the correct URL', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ hello: 'world' }));

    const result = await ctFetch('/runs/latest');

    expect(result).toEqual({ hello: 'world' });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:19001/runs/latest',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('appends query params and skips undefined values', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}));

    await ctFetch('/runs/latest', {
      projectPath: '/home/user',
      empty: undefined,
    });

    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toContain('projectPath=%2Fhome%2Fuser');
    expect(calledUrl).not.toContain('empty');
  });

  it('throws a friendly error on ECONNREFUSED', async () => {
    mockFetch.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));

    await expect(ctFetch('/runs/latest')).rejects.toThrow('not running');
  });

  it('throws a friendly error on timeout', async () => {
    mockFetch.mockRejectedValue(new Error('timed out'));

    await expect(ctFetch('/runs/latest')).rejects.toThrow('timed out');
  });

  it('throws on non-ok status with body', async () => {
    mockFetch.mockResolvedValue(jsonResponse('Not Found', 404));

    await expect(ctFetch('/runs/latest')).rejects.toThrow(
      'Control Tower returned 404',
    );
  });

  it('preserves base URL path components', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}));

    await ctFetch('/api/test');

    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toBe('http://localhost:19001/api/test');
  });
});

describe('ctFetchOrNull', () => {
  it('returns data on success', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: '1' }));

    const result = await ctFetchOrNull('/runs/latest');
    expect(result).toEqual({ id: '1' });
  });

  it('returns null when CT is not running', async () => {
    mockFetch.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));

    const result = await ctFetchOrNull('/runs/latest');
    expect(result).toBeNull();
  });

  it('returns null on timeout', async () => {
    mockFetch.mockRejectedValue(new Error('timed out'));

    const result = await ctFetchOrNull('/runs/latest');
    expect(result).toBeNull();
  });

  it('propagates server errors (e.g. 500)', async () => {
    mockFetch.mockResolvedValue(jsonResponse('Internal Server Error', 500));

    await expect(ctFetchOrNull('/runs/latest')).rejects.toThrow(
      'Control Tower returned 500',
    );
  });
});
