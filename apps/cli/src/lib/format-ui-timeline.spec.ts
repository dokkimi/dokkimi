import type { UiTimelineEntry, UiTimelineChild } from './inspect-types';
import {
  formatUiTimeline,
  formatStepCallTree,
  type TimelineRoot,
} from './format-ui-timeline';

// ---------------------------------------------------------------------------
// ANSI helpers — strip codes for readable assertions where color isn't tested
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
function strip(s: string): string {
  return s.replace(ANSI_RE, '');
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function root(overrides: Partial<TimelineRoot> = {}): TimelineRoot {
  return { stepLabel: 'Step 1', stepName: 'my-step', ...overrides };
}

function entry(overrides: Partial<UiTimelineEntry> = {}): UiTimelineEntry {
  return {
    stepIndex: 0,
    subStepIndex: 0,
    action: 'click',
    selector: '#btn',
    message: '',
    startTimestamp: '2025-01-01T00:00:00Z',
    endTimestamp: '2025-01-01T00:00:01Z',
    durationMs: 42,
    status: 'success',
    error: null,
    children: [],
    ...overrides,
  };
}

function httpChild(
  overrides: Partial<Extract<UiTimelineChild, { kind: 'http' }>> = {},
): UiTimelineChild {
  return {
    kind: 'http',
    timestamp: '2025-01-01T00:00:00Z',
    method: 'GET',
    url: '/api/items',
    statusCode: 200,
    origin: 'frontend',
    target: 'api-svc',
    isMocked: false,
    children: [],
    ...overrides,
  };
}

function dbChild(
  overrides: Partial<Extract<UiTimelineChild, { kind: 'db' }>> = {},
): UiTimelineChild {
  return {
    kind: 'db',
    timestamp: '2025-01-01T00:00:00Z',
    databaseType: 'postgres',
    databaseName: 'mydb',
    query: 'SELECT * FROM users',
    success: true,
    durationMs: 3,
    children: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// formatUiTimeline
// ---------------------------------------------------------------------------

describe('formatUiTimeline', () => {
  it('handles empty timeline', () => {
    const lines = formatUiTimeline('Test Title', root(), []);
    const joined = lines.map(strip).join('\n');
    expect(joined).toContain('No UI sub-steps recorded');
  });

  it('formats timeline entries with indentation', () => {
    const lines = formatUiTimeline('Test Title', root(), [
      entry({ action: 'click', selector: '#submit' }),
    ]);
    const joined = lines.map(strip).join('\n');
    expect(joined).toContain('click');
    expect(joined).toContain('#submit');
  });

  it('shows action descriptions for different action types', () => {
    const entries: UiTimelineEntry[] = [
      entry({ action: 'navigate', selector: null, subStepIndex: 0 }),
      entry({ action: 'click', selector: '#btn', subStepIndex: 1 }),
      entry({ action: 'type', selector: 'input.name', subStepIndex: 2 }),
      entry({ action: 'screenshot', selector: null, subStepIndex: 3 }),
    ];

    const lines = formatUiTimeline('Actions', root(), entries);
    const joined = lines.map(strip).join('\n');

    expect(joined).toContain('navigate');
    expect(joined).toContain('click');
    expect(joined).toContain('type');
    expect(joined).toContain('screenshot');
  });

  it('shows success status indicator', () => {
    const lines = formatUiTimeline('Title', root(), [
      entry({ status: 'success' }),
    ]);
    const joined = lines.join('\n');
    // Green checkmark
    expect(joined).toContain('\x1b[32m✓\x1b[0m');
  });

  it('shows failed status indicator', () => {
    const lines = formatUiTimeline('Title', root(), [
      entry({ status: 'failed', error: 'element not found' }),
    ]);
    const joined = lines.join('\n');
    // Red X
    expect(joined).toContain('\x1b[31m✗\x1b[0m');
    const stripped = lines.map(strip).join('\n');
    expect(stripped).toContain('element not found');
  });

  it('shows in-progress status indicator', () => {
    const lines = formatUiTimeline('Title', root(), [
      entry({ status: 'in-progress', durationMs: null }),
    ]);
    const joined = lines.join('\n');
    // Yellow spinner
    expect(joined).toContain('\x1b[33m⟳\x1b[0m');
  });

  it('shows duration when available', () => {
    const lines = formatUiTimeline('Title', root(), [
      entry({ durationMs: 42 }),
    ]);
    const stripped = lines.map(strip).join('\n');
    expect(stripped).toContain('42ms');
  });

  it('shows dash when duration is null', () => {
    const lines = formatUiTimeline('Title', root(), [
      entry({ durationMs: null }),
    ]);
    const stripped = lines.map(strip).join('\n');
    // formatDuration returns '-' for null
    expect(stripped).toContain('-');
  });

  it('shows duration in seconds for >= 1000ms', () => {
    const lines = formatUiTimeline('Title', root(), [
      entry({ durationMs: 2500 }),
    ]);
    const stripped = lines.map(strip).join('\n');
    expect(stripped).toContain('2.5s');
  });

  it('handles nested HTTP children', () => {
    const e = entry({
      action: 'click',
      selector: '#buy',
      children: [
        httpChild({ method: 'POST', url: '/cart/items', statusCode: 201 }),
      ],
    });

    const lines = formatUiTimeline('Title', root(), [e]);
    const stripped = lines.map(strip).join('\n');

    expect(stripped).toContain('HTTP');
    expect(stripped).toContain('POST');
    expect(stripped).toContain('/cart/items');
    expect(stripped).toContain('201');
  });

  it('handles nested DB children', () => {
    const e = entry({
      action: 'click',
      selector: '#save',
      children: [
        dbChild({
          query: 'INSERT INTO orders VALUES (1)',
          databaseName: 'orders-db',
        }),
      ],
    });

    const lines = formatUiTimeline('Title', root(), [e]);
    const stripped = lines.map(strip).join('\n');

    expect(stripped).toContain('DB');
    expect(stripped).toContain('INSERT INTO orders VALUES (1)');
    expect(stripped).toContain('orders-db');
  });

  it('shows stats header with passed/failed/in-progress counts', () => {
    const entries: UiTimelineEntry[] = [
      entry({ status: 'success', subStepIndex: 0 }),
      entry({ status: 'success', subStepIndex: 1 }),
      entry({ status: 'failed', error: 'timeout', subStepIndex: 2 }),
      entry({ status: 'in-progress', subStepIndex: 3 }),
    ];

    const lines = formatUiTimeline('Title', root(), entries);
    const stripped = lines.map(strip).join('\n');

    expect(stripped).toContain('2 passed');
    expect(stripped).toContain('1 failed');
    expect(stripped).toContain('1 in-progress');
  });

  it('renders step label and name', () => {
    const lines = formatUiTimeline(
      'My Title',
      root({ stepLabel: 'Step 3', stepName: 'checkout-flow' }),
      [entry()],
    );
    const stripped = lines.map(strip).join('\n');

    expect(stripped).toContain('Step 3: checkout-flow');
  });

  it('renders step label without name when stepName is empty', () => {
    const lines = formatUiTimeline(
      'Title',
      root({ stepLabel: 'Step 1', stepName: '' }),
      [entry()],
    );
    const stripped = lines.map(strip).join('\n');

    expect(stripped).toContain('Step 1');
    expect(stripped).not.toContain('Step 1:');
  });

  it('shows mocked indicator on HTTP children', () => {
    const e = entry({
      children: [httpChild({ isMocked: true })],
    });
    const lines = formatUiTimeline('Title', root(), [e]);
    const stripped = lines.map(strip).join('\n');
    expect(stripped).toContain('(mocked)');
  });

  it('shows error status on failed HTTP children (statusCode >= 400)', () => {
    const e = entry({
      children: [httpChild({ statusCode: 500 })],
    });
    const lines = formatUiTimeline('Title', root(), [e]);
    const joined = lines.join('\n');
    // Status code 500 should be rendered in red
    expect(joined).toContain('\x1b[31m500\x1b[0m');
  });

  it('renders deeply nested children with tree connectors', () => {
    const innerChild = httpChild({ method: 'GET', url: '/inner' });
    const outerChild: UiTimelineChild = {
      ...httpChild({ method: 'POST', url: '/outer' }),
      children: [innerChild],
    };
    const e = entry({ children: [outerChild] });

    const lines = formatUiTimeline('Title', root(), [e]);
    const stripped = lines.map(strip).join('\n');

    expect(stripped).toContain('/outer');
    expect(stripped).toContain('/inner');
  });
});

// ---------------------------------------------------------------------------
// formatStepCallTree
// ---------------------------------------------------------------------------

describe('formatStepCallTree', () => {
  it('renders title and step label', () => {
    const lines = formatStepCallTree(
      'Call Tree',
      root({ stepLabel: 'Step 2', stepName: 'api-call' }),
      [httpChild()],
    );
    const stripped = lines.map(strip).join('\n');

    expect(stripped).toContain('Call Tree');
    expect(stripped).toContain('Step 2: api-call');
  });

  it('handles empty calls list', () => {
    const lines = formatStepCallTree('Call Tree', root(), []);
    const stripped = lines.map(strip).join('\n');

    expect(stripped).toContain('No HTTP or DB activity recorded');
  });

  it('renders HTTP and DB calls', () => {
    const calls: UiTimelineChild[] = [
      httpChild({ method: 'POST', url: '/orders', statusCode: 201 }),
      dbChild({ query: 'INSERT INTO orders', databaseName: 'main-db' }),
    ];

    const lines = formatStepCallTree('Tree', root(), calls);
    const stripped = lines.map(strip).join('\n');

    expect(stripped).toContain('HTTP');
    expect(stripped).toContain('POST');
    expect(stripped).toContain('/orders');
    expect(stripped).toContain('DB');
    expect(stripped).toContain('INSERT INTO orders');
    expect(stripped).toContain('main-db');
  });

  it('uses tree connectors for multiple calls', () => {
    const calls: UiTimelineChild[] = [
      httpChild({ url: '/first' }),
      httpChild({ url: '/second' }),
    ];

    const lines = formatStepCallTree('Tree', root(), calls);
    const stripped = lines.map(strip).join('\n');

    // First uses ├─, last uses └─
    expect(stripped).toContain('├─');
    expect(stripped).toContain('└─');
  });
});
