import {
  prompt,
  fetchJson,
  fetchAction,
  fetchPost,
  fetchPostWithError,
  checkService,
  formatUptime,
  formatAge,
  sleep,
} from './cli-utils';

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const mockFetch = jest.fn() as jest.Mock;
(globalThis as any).fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

// ---------------------------------------------------------------------------
// fetchJson
// ---------------------------------------------------------------------------

describe('fetchJson', () => {
  it('returns parsed JSON on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 1, name: 'test' }),
    });
    const result = await fetchJson('http://localhost/api');
    expect(result).toEqual({ id: 1, name: 'test' });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost/api',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('returns null on non-OK response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });
    const result = await fetchJson('http://localhost/api');
    expect(result).toBeNull();
  });

  it('returns null on fetch error', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    const result = await fetchJson('http://localhost/api');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchAction
// ---------------------------------------------------------------------------

describe('fetchAction', () => {
  it('returns true on OK response', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    const result = await fetchAction('http://localhost/api', 'POST');
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost/api',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('returns false on non-OK response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    const result = await fetchAction('http://localhost/api', 'DELETE');
    expect(result).toBe(false);
  });

  it('returns false on error', async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'));
    const result = await fetchAction('http://localhost/api', 'POST');
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchPost
// ---------------------------------------------------------------------------

describe('fetchPost', () => {
  it('returns parsed JSON on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ created: true }),
    });
    const result = await fetchPost('http://localhost/api', { name: 'test' });
    expect(result).toEqual({ created: true });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost/api',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test' }),
      }),
    );
  });

  it('returns null on non-OK response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400 });
    const result = await fetchPost('http://localhost/api', {});
    expect(result).toBeNull();
  });

  it('returns null on error', async () => {
    mockFetch.mockRejectedValue(new Error('fail'));
    const result = await fetchPost('http://localhost/api', {});
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchPostWithError
// ---------------------------------------------------------------------------

describe('fetchPostWithError', () => {
  it('returns {data} on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 42 }),
    });
    const result = await fetchPostWithError('http://localhost/api', {
      x: 1,
    });
    expect(result).toEqual({ data: { id: 42 } });
  });

  it('returns {error} with message field from body on non-OK', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ message: 'Validation failed' }),
    });
    const result = await fetchPostWithError('http://localhost/api', {});
    expect(result).toEqual({ error: 'Validation failed' });
  });

  it('returns {error} with error field from body on non-OK', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Bad request' }),
    });
    const result = await fetchPostWithError('http://localhost/api', {});
    expect(result).toEqual({ error: 'Bad request' });
  });

  it('returns {error: "HTTP N"} when body parse fails', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => {
        throw new Error('not json');
      },
    });
    const result = await fetchPostWithError('http://localhost/api', {});
    expect(result).toEqual({ error: 'HTTP 503' });
  });

  it('returns timeout error on DOMException TimeoutError', async () => {
    const err = new DOMException('signal timed out', 'TimeoutError');
    mockFetch.mockRejectedValue(err);
    const result = await fetchPostWithError('http://localhost/api', {});
    expect(result).toEqual({
      error: 'Request timed out — service may not be running',
    });
  });

  it('returns generic error message on other errors', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await fetchPostWithError('http://localhost/api', {});
    expect(result).toEqual({ error: 'ECONNREFUSED' });
  });

  it('returns "Connection failed" for non-Error throws', async () => {
    mockFetch.mockRejectedValue('something weird');
    const result = await fetchPostWithError('http://localhost/api', {});
    expect(result).toEqual({ error: 'Connection failed' });
  });
});

// ---------------------------------------------------------------------------
// checkService
// ---------------------------------------------------------------------------

describe('checkService', () => {
  it('returns healthy:true on OK response', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    const result = await checkService('ct', 'http://localhost:19001');
    expect(result).toEqual({
      name: 'ct',
      url: 'http://localhost:19001',
      healthy: true,
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:19001/health',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('returns healthy:false with HTTP detail on non-OK', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    const result = await checkService('ct', 'http://localhost:19001');
    expect(result).toEqual({
      name: 'ct',
      url: 'http://localhost:19001',
      healthy: false,
      detail: 'HTTP 503',
    });
  });

  it('returns healthy:false with detail on error', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await checkService('ct', 'http://localhost:19001');
    expect(result).toEqual({
      name: 'ct',
      url: 'http://localhost:19001',
      healthy: false,
      detail: 'not reachable',
    });
  });
});

// ---------------------------------------------------------------------------
// formatUptime
// ---------------------------------------------------------------------------

describe('formatUptime', () => {
  it('formats seconds only', () => {
    expect(formatUptime(30)).toBe('30s');
  });

  it('formats minutes', () => {
    expect(formatUptime(90)).toBe('1m');
  });

  it('formats hours and minutes', () => {
    expect(formatUptime(3700)).toBe('1h 1m');
  });

  it('formats days and hours', () => {
    expect(formatUptime(90000)).toBe('1d 1h');
  });

  it('formats exactly 60 seconds as 1m', () => {
    expect(formatUptime(60)).toBe('1m');
  });

  it('formats exactly 3600 seconds as 1h 0m', () => {
    expect(formatUptime(3600)).toBe('1h 0m');
  });
});

// ---------------------------------------------------------------------------
// formatAge
// ---------------------------------------------------------------------------

describe('formatAge', () => {
  it('returns relative time string ending in "ago"', () => {
    const tenMinutesAgo = new Date(Date.now() - 600_000).toISOString();
    const result = formatAge(tenMinutesAgo);
    expect(result).toMatch(/ago$/);
    expect(result).toContain('10m');
  });

  it('returns "unknown" for invalid date', () => {
    expect(formatAge('not-a-date')).toBe('unknown');
  });

  it('returns "unknown" for empty string', () => {
    expect(formatAge('')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------

describe('sleep', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves after the specified delay', async () => {
    const promise = sleep(1000);

    // Advance timers
    jest.advanceTimersByTime(1000);

    // The promise should resolve
    await expect(promise).resolves.toBeUndefined();
  });

  it('does not resolve before the delay', async () => {
    let resolved = false;
    const promise = sleep(500).then(() => {
      resolved = true;
    });

    jest.advanceTimersByTime(499);
    await Promise.resolve(); // flush microtasks
    expect(resolved).toBe(false);

    jest.advanceTimersByTime(1);
    await promise;
    expect(resolved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// prompt
// ---------------------------------------------------------------------------

describe('prompt', () => {
  it('returns user input trimmed and lowercased', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const readline = require('readline');
    const mockQuestion = jest.fn((_q: string, cb: (answer: string) => void) => {
      cb('  YES  ');
    });
    const mockClose = jest.fn();
    jest.spyOn(readline, 'createInterface').mockReturnValue({
      question: mockQuestion,
      close: mockClose,
    });

    const result = await prompt('Continue?');
    expect(result).toBe('yes');
    expect(mockClose).toHaveBeenCalled();

    (readline.createInterface as jest.Mock).mockRestore();
  });

  it('returns empty string when not TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    });

    const result = await prompt('Continue?');
    expect(result).toBe('');
  });
});
