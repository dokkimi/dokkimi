import {
  fitText,
  detailRow,
  formatDuration,
  statusColor,
  statusCodeColor,
  httpMethodColor,
  statusBadge,
  describeAction,
  formatAssertionLine,
  coloredJsonLines,
  itemTypeColor,
  itemStatusSuffix,
  formatLogLine,
  formatDbLogLine,
  buildHttpDetailLines,
  buildDbDetailLines,
} from './formatting';
import type {
  TestStep,
  AssertionResult,
  InstanceItemStatus,
  HttpLog,
  DatabaseLog,
} from './inspect-types';

// ---------------------------------------------------------------------------
// fitText
// ---------------------------------------------------------------------------

describe('fitText', () => {
  it('truncates long text with ellipsis', () => {
    const result = fitText('hello world', 5);
    expect(result).toBe('hell…');
    expect(result.length).toBe(5);
  });

  it('pads short text to maxLen', () => {
    const result = fitText('hi', 6);
    expect(result).toBe('hi    ');
    expect(result.length).toBe(6);
  });

  it('returns exact-length text unchanged', () => {
    expect(fitText('abcde', 5)).toBe('abcde');
  });

  it('handles empty string', () => {
    const result = fitText('', 4);
    expect(result).toBe('    ');
    expect(result.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// detailRow
// ---------------------------------------------------------------------------

describe('detailRow', () => {
  it('formats label padded to 10 chars with value', () => {
    const result = detailRow('Status', '200');
    expect(result).toContain('Status');
    expect(result).toContain('200');
    // label is wrapped in dim color
    expect(result).toContain('\x1b[90m');
    expect(result).toContain('\x1b[0m');
  });

  it('pads short labels', () => {
    const result = detailRow('OK', 'val');
    // "OK" padded to 10
    expect(result).toContain('OK        ');
  });
});

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe('formatDuration', () => {
  it('shows milliseconds for sub-second values', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('shows seconds with one decimal for >= 1000ms', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(12345)).toBe('12.3s');
  });
});

// ---------------------------------------------------------------------------
// statusColor
// ---------------------------------------------------------------------------

describe('statusColor', () => {
  it('returns green for PASSED', () => {
    expect(statusColor('PASSED')).toBe('\x1b[32m');
  });

  it('returns green for COMPLETED', () => {
    expect(statusColor('COMPLETED')).toBe('\x1b[32m');
  });

  it('returns red for FAILED', () => {
    expect(statusColor('FAILED')).toBe('\x1b[31m');
  });

  it('returns dim for SKIPPED', () => {
    expect(statusColor('SKIPPED')).toBe('\x1b[90m');
  });

  it('returns dim for NOT_VALIDATED', () => {
    expect(statusColor('NOT_VALIDATED')).toBe('\x1b[90m');
  });

  it('returns dim for PENDING', () => {
    expect(statusColor('PENDING')).toBe('\x1b[90m');
  });

  it('returns yellow for RUNNING', () => {
    expect(statusColor('RUNNING')).toBe('\x1b[33m');
  });

  it('returns cyan for unknown status', () => {
    expect(statusColor('WHATEVER')).toBe('\x1b[36m');
  });
});

// ---------------------------------------------------------------------------
// statusCodeColor
// ---------------------------------------------------------------------------

describe('statusCodeColor', () => {
  it('returns green for 2xx', () => {
    expect(statusCodeColor(200)).toBe('\x1b[32m');
    expect(statusCodeColor(204)).toBe('\x1b[32m');
  });

  it('returns cyan for 3xx', () => {
    expect(statusCodeColor(301)).toBe('\x1b[36m');
    expect(statusCodeColor(304)).toBe('\x1b[36m');
  });

  it('returns yellow for 4xx', () => {
    expect(statusCodeColor(400)).toBe('\x1b[33m');
    expect(statusCodeColor(404)).toBe('\x1b[33m');
  });

  it('returns red for 5xx', () => {
    expect(statusCodeColor(500)).toBe('\x1b[31m');
    expect(statusCodeColor(503)).toBe('\x1b[31m');
  });
});

// ---------------------------------------------------------------------------
// httpMethodColor
// ---------------------------------------------------------------------------

describe('httpMethodColor', () => {
  it('returns blue for GET', () => {
    expect(httpMethodColor('GET')).toBe('\x1b[34m');
  });

  it('returns green for POST', () => {
    expect(httpMethodColor('POST')).toBe('\x1b[32m');
  });

  it('returns yellow for PUT', () => {
    expect(httpMethodColor('PUT')).toBe('\x1b[33m');
  });

  it('returns red for DELETE', () => {
    expect(httpMethodColor('DELETE')).toBe('\x1b[31m');
  });

  it('returns yellow for PATCH', () => {
    expect(httpMethodColor('PATCH')).toBe('\x1b[33m');
  });

  it('returns magenta for HEAD', () => {
    expect(httpMethodColor('HEAD')).toBe('\x1b[35m');
  });

  it('returns cyan for OPTIONS', () => {
    expect(httpMethodColor('OPTIONS')).toBe('\x1b[36m');
  });

  it('returns white for unknown method', () => {
    expect(httpMethodColor('TRACE')).toBe('\x1b[37m');
  });

  it('is case-insensitive', () => {
    expect(httpMethodColor('get')).toBe('\x1b[34m');
    expect(httpMethodColor('Post')).toBe('\x1b[32m');
  });
});

// ---------------------------------------------------------------------------
// statusBadge
// ---------------------------------------------------------------------------

describe('statusBadge', () => {
  it('wraps status text in color and reset codes', () => {
    const badge = statusBadge('PASSED');
    expect(badge).toBe('\x1b[32mPASSED\x1b[0m');
  });

  it('uses red for FAILED', () => {
    const badge = statusBadge('FAILED');
    expect(badge).toBe('\x1b[31mFAILED\x1b[0m');
  });
});

// ---------------------------------------------------------------------------
// describeAction
// ---------------------------------------------------------------------------

describe('describeAction', () => {
  it('describes httpRequest with method and url', () => {
    const step: TestStep = {
      action: { type: 'httpRequest', method: 'GET', url: '/api/users' },
    };
    expect(describeAction(step)).toBe('GET /api/users');
  });

  it('uses ? for missing method in httpRequest', () => {
    const step: TestStep = {
      action: { type: 'httpRequest', url: '/api' },
    };
    expect(describeAction(step)).toBe('? /api');
  });

  it('describes dbQuery with database and truncated query', () => {
    const step: TestStep = {
      action: {
        type: 'dbQuery',
        database: 'mydb',
        query: 'SELECT * FROM users WHERE active = true',
      },
    };
    expect(describeAction(step)).toBe(
      'mydb: SELECT * FROM users WHERE active = true',
    );
  });

  it('truncates long dbQuery queries to 40 chars', () => {
    const longQuery =
      'SELECT id, name, email, phone, address FROM users WHERE active = true AND verified = true';
    const step: TestStep = {
      action: { type: 'dbQuery', database: 'db', query: longQuery },
    };
    const result = describeAction(step);
    expect(result).toBe(`db: ${longQuery.slice(0, 40)}...`);
  });

  it('uses "db" for missing database name in dbQuery', () => {
    const step: TestStep = {
      action: { type: 'dbQuery', query: 'SELECT 1' },
    };
    expect(describeAction(step)).toBe('db: SELECT 1');
  });

  it('returns the type for UI-type actions', () => {
    const step: TestStep = { action: { type: 'uiAction' } };
    expect(describeAction(step)).toBe('uiAction');
  });

  it('returns "(no action)" when action is undefined', () => {
    const step: TestStep = {};
    expect(describeAction(step)).toBe('(no action)');
  });

  it('returns "(unknown action)" when type is undefined', () => {
    const step: TestStep = { action: {} };
    expect(describeAction(step)).toBe('(unknown action)');
  });
});

// ---------------------------------------------------------------------------
// formatAssertionLine
// ---------------------------------------------------------------------------

describe('formatAssertionLine', () => {
  const baseAssertion: AssertionResult = {
    id: '1',
    instanceId: 'inst-1',
    stepIndex: 0,
    assertionIndex: 0,
    assertionType: '',
    passed: true,
    expected: null,
    actual: null,
    error: null,
    path: null,
    operator: null,
    blockIndex: null,
    resultKind: null,
  };

  it('builds description from type, path, and operator', () => {
    const a: AssertionResult = {
      ...baseAssertion,
      assertionType: 'response.statusCode',
      path: '$.status',
      operator: 'equals',
    };
    const result = formatAssertionLine(a);
    expect(result).toContain('response.statusCode');
    expect(result).toContain('$.status');
    expect(result).toContain('equals');
  });

  it('works with only assertionType', () => {
    const a: AssertionResult = {
      ...baseAssertion,
      assertionType: 'response.body',
    };
    expect(formatAssertionLine(a)).toBe('response.body');
  });

  it('falls back to "assertion #N" when no parts', () => {
    const a: AssertionResult = {
      ...baseAssertion,
      assertionIndex: 2,
    };
    expect(formatAssertionLine(a)).toBe('assertion #3');
  });
});

// ---------------------------------------------------------------------------
// coloredJsonLines
// ---------------------------------------------------------------------------

describe('coloredJsonLines', () => {
  it('returns colored string for string input', () => {
    const lines = coloredJsonLines('hello');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('hello');
    // orange color code
    expect(lines[0]).toContain('\x1b[38;5;173m');
  });

  it('returns indented colored JSON for object input', () => {
    const lines = coloredJsonLines({ key: 'value' });
    expect(lines.length).toBeGreaterThan(1);
    // Each line should be indented
    lines.forEach((line) => {
      expect(line.startsWith('  ')).toBe(true);
    });
    // Should contain key in cyan
    expect(lines.join('\n')).toContain('\x1b[36m');
  });

  it('returns colored JSON for array input', () => {
    const lines = coloredJsonLines([1, 2, 3]);
    expect(lines.length).toBeGreaterThan(1);
    // Should contain purple brackets for arrays
    expect(lines.join('\n')).toContain('\x1b[35m');
  });
});

// ---------------------------------------------------------------------------
// itemTypeColor
// ---------------------------------------------------------------------------

describe('itemTypeColor', () => {
  it('returns cyan for SERVICE', () => {
    expect(itemTypeColor('SERVICE')).toBe('\x1b[36m');
  });

  it('returns yellow for DATABASE', () => {
    expect(itemTypeColor('DATABASE')).toBe('\x1b[33m');
  });

  it('returns green for MOCK', () => {
    expect(itemTypeColor('MOCK')).toBe('\x1b[32m');
  });

  it('returns white for unknown type', () => {
    expect(itemTypeColor('OTHER')).toBe('\x1b[37m');
  });
});

// ---------------------------------------------------------------------------
// itemStatusSuffix
// ---------------------------------------------------------------------------

describe('itemStatusSuffix', () => {
  it('returns FAILED suffix for CRASHED items', () => {
    const items: InstanceItemStatus[] = [
      {
        id: '1',
        itemDefinitionName: 'my-service',
        status: 'CRASHED',
        readinessStatus: null,
      },
    ];
    const result = itemStatusSuffix('my-service', items);
    expect(result.text).toContain('FAILED');
    expect(result.len).toBe(8);
  });

  it('returns FAILED TO START for NOT_READY items', () => {
    const items: InstanceItemStatus[] = [
      {
        id: '1',
        itemDefinitionName: 'my-service',
        status: 'RUNNING',
        readinessStatus: 'NOT_READY',
      },
    ];
    const result = itemStatusSuffix('my-service', items);
    expect(result.text).toContain('FAILED TO START');
    expect(result.len).toBe(17);
  });

  it('returns empty for healthy items', () => {
    const items: InstanceItemStatus[] = [
      {
        id: '1',
        itemDefinitionName: 'my-service',
        status: 'RUNNING',
        readinessStatus: 'READY',
      },
    ];
    const result = itemStatusSuffix('my-service', items);
    expect(result.text).toBe('');
    expect(result.len).toBe(0);
  });

  it('returns empty when item not found', () => {
    const result = itemStatusSuffix('missing', []);
    expect(result.text).toBe('');
    expect(result.len).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatLogLine
// ---------------------------------------------------------------------------

describe('formatLogLine', () => {
  const originalColumns = process.stdout.columns;

  beforeEach(() => {
    Object.defineProperty(process.stdout, 'columns', {
      value: 120,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'columns', {
      value: originalColumns,
      writable: true,
      configurable: true,
    });
  });

  const baseLog: HttpLog = {
    id: '1',
    method: 'GET',
    url: '/api/users',
    statusCode: 200,
    origin: 'frontend',
    target: 'backend',
    requestBody: null,
    responseBody: null,
    requestHeaders: null,
    responseHeaders: null,
    isMocked: false,
    requestSentAt: null,
    responseReceivedAt: null,
    duration: 150,
  };

  it('formats a basic log line with method, url, status, and duration', () => {
    const result = formatLogLine(baseLog, false);
    expect(result).toContain('GET');
    expect(result).toContain('/api/users');
    expect(result).toContain('200');
    expect(result).toContain('150ms');
    expect(result).toContain('→');
  });

  it('includes origin when showOrigin is true', () => {
    const result = formatLogLine(baseLog, true);
    expect(result).toContain('frontend');
  });

  it('omits origin when showOrigin is false', () => {
    const result = formatLogLine(baseLog, false);
    expect(result).not.toContain('frontend');
  });

  it('shows [mocked] for mocked logs', () => {
    const log: HttpLog = { ...baseLog, isMocked: true };
    const result = formatLogLine(log, false);
    expect(result).toContain('[mocked]');
  });
});

// ---------------------------------------------------------------------------
// formatDbLogLine
// ---------------------------------------------------------------------------

describe('formatDbLogLine', () => {
  const originalColumns = process.stdout.columns;

  beforeEach(() => {
    Object.defineProperty(process.stdout, 'columns', {
      value: 120,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'columns', {
      value: originalColumns,
      writable: true,
      configurable: true,
    });
  });

  const baseDbLog: DatabaseLog = {
    id: '1',
    instanceId: 'inst-1',
    instanceItemId: null,
    databaseType: 'postgres',
    databaseName: 'mydb',
    query: 'SELECT * FROM users',
    params: null,
    success: true,
    data: null,
    rowsAffected: null,
    error: null,
    duration: 50,
    timestamp: '2026-01-01T00:00:00Z',
  };

  it('formats a successful db log line', () => {
    const result = formatDbLogLine(baseDbLog);
    expect(result).toContain('mydb');
    expect(result).toContain('SELECT * FROM users');
    expect(result).toContain('SUCCESS');
    expect(result).toContain('50ms');
  });

  it('shows FAILED for unsuccessful queries', () => {
    const log: DatabaseLog = { ...baseDbLog, success: false };
    const result = formatDbLogLine(log);
    expect(result).toContain('FAILED');
  });
});

// ---------------------------------------------------------------------------
// buildHttpDetailLines
// ---------------------------------------------------------------------------

describe('buildHttpDetailLines', () => {
  const baseLog: HttpLog = {
    id: '1',
    method: 'POST',
    url: '/api/users',
    statusCode: 201,
    origin: 'frontend',
    target: 'backend',
    requestBody: { name: 'Alice' },
    responseBody: { id: 1 },
    requestHeaders: { 'content-type': 'application/json' },
    responseHeaders: { 'x-request-id': 'abc-123' },
    isMocked: false,
    requestSentAt: '2026-01-15T12:00:00Z',
    responseReceivedAt: '2026-01-15T12:00:01Z',
    duration: 250,
  };

  it('includes method and endpoint in first line', () => {
    const lines = buildHttpDetailLines(baseLog);
    expect(lines[0]).toContain('POST');
    expect(lines[0]).toContain('/api/users');
  });

  it('includes status code', () => {
    const lines = buildHttpDetailLines(baseLog);
    const statusLine = lines.find((l) => l.includes('Status'));
    expect(statusLine).toBeDefined();
    expect(statusLine).toContain('201');
  });

  it('includes origin', () => {
    const lines = buildHttpDetailLines(baseLog);
    const originLine = lines.find((l) => l.includes('Origin'));
    expect(originLine).toBeDefined();
    expect(originLine).toContain('frontend');
  });

  it('includes target', () => {
    const lines = buildHttpDetailLines(baseLog);
    const targetLine = lines.find((l) => l.includes('Target'));
    expect(targetLine).toBeDefined();
    expect(targetLine).toContain('backend');
  });

  it('includes formatted duration', () => {
    const lines = buildHttpDetailLines(baseLog);
    const durLine = lines.find((l) => l.includes('Duration'));
    expect(durLine).toBeDefined();
    expect(durLine).toContain('250ms');
  });

  it('shows mocked as no for non-mocked logs', () => {
    const lines = buildHttpDetailLines(baseLog);
    const mockedLine = lines.find((l) => l.includes('Mocked'));
    expect(mockedLine).toBeDefined();
    expect(mockedLine).toContain('no');
  });

  it('shows mocked as yes for mocked logs', () => {
    const lines = buildHttpDetailLines({ ...baseLog, isMocked: true });
    const mockedLine = lines.find((l) => l.includes('Mocked'));
    expect(mockedLine).toBeDefined();
    expect(mockedLine).toContain('yes');
  });

  it('includes request headers section', () => {
    const lines = buildHttpDetailLines(baseLog);
    const headerLine = lines.find((l) => l.includes('Request Headers'));
    expect(headerLine).toBeDefined();
    expect(lines.join('\n')).toContain('content-type');
  });

  it('includes request body section', () => {
    const lines = buildHttpDetailLines(baseLog);
    const bodyLine = lines.find((l) => l.includes('Request Body'));
    expect(bodyLine).toBeDefined();
    expect(lines.join('\n')).toContain('Alice');
  });

  it('includes response headers section', () => {
    const lines = buildHttpDetailLines(baseLog);
    const headerLine = lines.find((l) => l.includes('Response Headers'));
    expect(headerLine).toBeDefined();
    expect(lines.join('\n')).toContain('x-request-id');
  });

  it('includes response body section', () => {
    const lines = buildHttpDetailLines(baseLog);
    const bodyLine = lines.find((l) => l.includes('Response Body'));
    expect(bodyLine).toBeDefined();
  });

  it('omits headers sections when empty', () => {
    const log: HttpLog = {
      ...baseLog,
      requestHeaders: null,
      responseHeaders: null,
      requestBody: null,
      responseBody: null,
    };
    const lines = buildHttpDetailLines(log);
    const joined = lines.join('\n');
    expect(joined).not.toContain('Request Headers');
    expect(joined).not.toContain('Response Headers');
    expect(joined).not.toContain('Request Body');
    expect(joined).not.toContain('Response Body');
  });

  it('shows dash for missing origin and target', () => {
    const log: HttpLog = { ...baseLog, origin: null, target: null };
    const lines = buildHttpDetailLines(log);
    const originLine = lines.find((l) => l.includes('Origin'));
    const targetLine = lines.find((l) => l.includes('Target'));
    expect(originLine).toContain('—');
    expect(targetLine).toContain('—');
  });

  it('strips http:// from full URLs in endpoint', () => {
    const log: HttpLog = { ...baseLog, url: 'http://backend:8080/api/users' };
    const lines = buildHttpDetailLines(log);
    expect(lines[0]).toContain('backend:8080/api/users');
    expect(lines[0]).not.toContain('http://');
  });

  it('shows dash for missing duration', () => {
    const log: HttpLog = { ...baseLog, duration: null };
    const lines = buildHttpDetailLines(log);
    const durLine = lines.find((l) => l.includes('Duration'));
    expect(durLine).toContain('—');
  });

  it('formats time as ISO string', () => {
    const lines = buildHttpDetailLines(baseLog);
    const timeLine = lines.find((l) => l.includes('Time'));
    expect(timeLine).toContain('2026-01-15T12:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// buildDbDetailLines
// ---------------------------------------------------------------------------

describe('buildDbDetailLines', () => {
  const baseDbLog: DatabaseLog = {
    id: '1',
    instanceId: 'inst-1',
    instanceItemId: null,
    databaseType: 'postgres',
    databaseName: 'mydb',
    query: 'SELECT * FROM users',
    params: null,
    success: true,
    data: [{ id: 1, name: 'Alice' }],
    rowsAffected: 1,
    error: null,
    duration: 50,
    timestamp: '2026-01-01T00:00:00Z',
  };

  it('includes database name and type', () => {
    const lines = buildDbDetailLines(baseDbLog);
    const dbLine = lines.find((l) => l.includes('Database'));
    expect(dbLine).toBeDefined();
    expect(dbLine).toContain('mydb');
    expect(dbLine).toContain('postgres');
  });

  it('includes query text', () => {
    const lines = buildDbDetailLines(baseDbLog);
    const joined = lines.join('\n');
    expect(joined).toContain('SELECT * FROM users');
  });

  it('shows SUCCESS status for successful queries', () => {
    const lines = buildDbDetailLines(baseDbLog);
    const statusLine = lines.find((l) => l.includes('Status'));
    expect(statusLine).toBeDefined();
    expect(statusLine).toContain('SUCCESS');
  });

  it('shows FAILED status for failed queries', () => {
    const lines = buildDbDetailLines({ ...baseDbLog, success: false });
    const statusLine = lines.find((l) => l.includes('Status'));
    expect(statusLine).toContain('FAILED');
  });

  it('includes formatted duration', () => {
    const lines = buildDbDetailLines(baseDbLog);
    const durLine = lines.find((l) => l.includes('Duration'));
    expect(durLine).toBeDefined();
    expect(durLine).toContain('50ms');
  });

  it('omits duration row when null', () => {
    const lines = buildDbDetailLines({ ...baseDbLog, duration: null });
    const durLine = lines.find((l) => l.includes('Duration'));
    expect(durLine).toBeUndefined();
  });

  it('includes rows affected', () => {
    const lines = buildDbDetailLines(baseDbLog);
    const rowsLine = lines.find((l) => l.includes('Rows'));
    expect(rowsLine).toBeDefined();
    expect(rowsLine).toContain('1');
  });

  it('omits rows row when null', () => {
    const lines = buildDbDetailLines({ ...baseDbLog, rowsAffected: null });
    const rowsLine = lines.find((l) => l.includes('Rows'));
    expect(rowsLine).toBeUndefined();
  });

  it('includes error message when present', () => {
    const lines = buildDbDetailLines({
      ...baseDbLog,
      success: false,
      error: 'relation "users" does not exist',
    });
    const joined = lines.join('\n');
    expect(joined).toContain('relation "users" does not exist');
  });

  it('omits error when null', () => {
    const lines = buildDbDetailLines(baseDbLog);
    const _joined = lines.join('\n');
    // Should not have error styling (red) beyond status
    const errorLines = lines.filter(
      (l) => l.includes('\x1b[31m') && !l.includes('Status'),
    );
    expect(errorLines).toHaveLength(0);
  });

  it('includes data section when data is present', () => {
    const lines = buildDbDetailLines(baseDbLog);
    const dataLine = lines.find((l) => l.includes('Data'));
    expect(dataLine).toBeDefined();
    const joined = lines.join('\n');
    expect(joined).toContain('Alice');
  });

  it('omits data section when data is null', () => {
    const lines = buildDbDetailLines({ ...baseDbLog, data: null });
    const hasDataHeader = lines.some(
      (l) => l.includes('Data') && !l.includes('Database'),
    );
    expect(hasDataHeader).toBe(false);
  });

  it('omits data section when data is empty array', () => {
    const lines = buildDbDetailLines({ ...baseDbLog, data: [] });
    const hasDataHeader = lines.some(
      (l) => l.includes('Data') && !l.includes('Database'),
    );
    expect(hasDataHeader).toBe(false);
  });

  it('shows duration in seconds for long queries', () => {
    const lines = buildDbDetailLines({ ...baseDbLog, duration: 2500 });
    const durLine = lines.find((l) => l.includes('Duration'));
    expect(durLine).toContain('2.5s');
  });
});
