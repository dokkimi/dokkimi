import { EventEmitter } from 'events';

describe('selectMenu', () => {
  let stdoutWriteSpy: jest.SpyInstance;
  let mockStdin: EventEmitter & {
    isTTY: boolean;
    setRawMode: jest.Mock;
    resume: jest.Mock;
    pause: jest.Mock;
    setEncoding: jest.Mock;
  };
  let originalStdin: typeof process.stdin;

  beforeEach(() => {
    stdoutWriteSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    // Create a mock stdin that extends EventEmitter
    // The real removeAllListeners from EventEmitter is fine to use as-is
    const emitter = new EventEmitter();
    mockStdin = Object.assign(emitter, {
      isTTY: true as boolean,
      setRawMode: jest.fn(),
      resume: jest.fn(),
      pause: jest.fn(),
      setEncoding: jest.fn(),
    });

    originalStdin = process.stdin;
    Object.defineProperty(process, 'stdin', {
      value: mockStdin,
      configurable: true,
    });

    Object.defineProperty(process.stdout, 'rows', {
      value: 24,
      configurable: true,
    });

    jest.resetModules();
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    Object.defineProperty(process, 'stdin', {
      value: originalStdin,
      configurable: true,
    });
  });

  function loadMenu() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('./menu') as typeof import('./menu');
  }

  it('returns null for empty options', async () => {
    const { selectMenu } = loadMenu();
    const result = await selectMenu([], 'Pick one');
    expect(result).toBeNull();
  });

  it('returns null when all items are disabled', async () => {
    const { selectMenu } = loadMenu();
    const result = await selectMenu(
      [
        { label: 'A', value: 'a', disabled: true },
        { label: 'B', value: 'b', disabled: true },
      ],
      'Pick one',
    );
    expect(result).toBeNull();
  });

  it('returns null when not a TTY', async () => {
    mockStdin.isTTY = false;
    const { selectMenu } = loadMenu();
    const result = await selectMenu(
      [{ label: 'Option A', value: 'a' }],
      'Pick one',
    );
    expect(result).toBeNull();
  });

  it('returns selected value when Enter is pressed', async () => {
    const { selectMenu } = loadMenu();

    const promise = selectMenu(
      [
        { label: 'Option A', value: 'a' },
        { label: 'Option B', value: 'b' },
      ],
      'Pick one',
    );

    // Simulate pressing Enter (selects first item by default)
    process.nextTick(() => {
      mockStdin.emit('data', '\r');
    });

    const result = await promise;
    expect(result).toEqual({ value: 'a', index: 0 });
  });

  it('returns null when Escape is pressed', async () => {
    const { selectMenu } = loadMenu();

    const promise = selectMenu(
      [
        { label: 'Option A', value: 'a' },
        { label: 'Option B', value: 'b' },
      ],
      'Pick one',
    );

    process.nextTick(() => {
      mockStdin.emit('data', '\x1b');
    });

    const result = await promise;
    expect(result).toBeNull();
  });

  it('returns null when q is pressed', async () => {
    const { selectMenu } = loadMenu();

    const promise = selectMenu([{ label: 'Option A', value: 'a' }], 'Pick one');

    process.nextTick(() => {
      mockStdin.emit('data', 'q');
    });

    const result = await promise;
    expect(result).toBeNull();
  });

  it('navigates down with arrow key and selects second item', async () => {
    const { selectMenu } = loadMenu();

    const promise = selectMenu(
      [
        { label: 'Option A', value: 'a' },
        { label: 'Option B', value: 'b' },
      ],
      'Pick one',
    );

    process.nextTick(() => {
      // Down arrow
      mockStdin.emit('data', '\x1b[B');
      // Enter
      process.nextTick(() => {
        mockStdin.emit('data', '\r');
      });
    });

    const result = await promise;
    expect(result).toEqual({ value: 'b', index: 1 });
  });

  it('returns null on left-arrow when leftArrowBack is enabled', async () => {
    const { selectMenu } = loadMenu();

    const promise = selectMenu(
      [{ label: 'Option A', value: 'a' }],
      'Sub-menu',
      { leftArrowBack: true },
    );

    process.nextTick(() => {
      mockStdin.emit('data', '\x1b[D'); // left arrow
    });

    const result = await promise;
    expect(result).toBeNull();
  });

  it('does not go back on left-arrow when leftArrowBack is false', async () => {
    const { selectMenu } = loadMenu();

    const promise = selectMenu(
      [{ label: 'Option A', value: 'a' }],
      'Root menu',
      { leftArrowBack: false },
    );

    process.nextTick(() => {
      // Left arrow should be ignored; then press Enter to resolve
      mockStdin.emit('data', '\x1b[D');
      process.nextTick(() => {
        mockStdin.emit('data', '\r');
      });
    });

    const result = await promise;
    expect(result).toEqual({ value: 'a', index: 0 });
  });

  it('handles right-arrow as select (Enter equivalent)', async () => {
    const { selectMenu } = loadMenu();

    const promise = selectMenu([{ label: 'Option A', value: 'a' }], 'Pick one');

    process.nextTick(() => {
      mockStdin.emit('data', '\x1b[C'); // right arrow
    });

    const result = await promise;
    expect(result).toEqual({ value: 'a', index: 0 });
  });

  it('skips disabled items when navigating', async () => {
    const { selectMenu } = loadMenu();

    const promise = selectMenu(
      [
        { label: 'Option A', value: 'a' },
        { label: 'Disabled', value: 'x', disabled: true },
        { label: 'Option C', value: 'c' },
      ],
      'Pick one',
    );

    process.nextTick(() => {
      // Down arrow should skip disabled item and land on index 2
      mockStdin.emit('data', '\x1b[B');
      process.nextTick(() => {
        mockStdin.emit('data', '\r');
      });
    });

    const result = await promise;
    expect(result).toEqual({ value: 'c', index: 2 });
  });

  it('resolves with custom action from onKey handler', async () => {
    const { selectMenu } = loadMenu();

    const promise = selectMenu(
      [
        { label: 'Option A', value: 'a' },
        { label: 'Option B', value: 'b' },
      ],
      'Pick one',
      {
        onKey: (key: string) => (key === 'A' ? 'approve-all' : null),
      },
    );

    process.nextTick(() => {
      mockStdin.emit('data', 'A');
    });

    const result = await promise;
    expect(result).toEqual({ value: 'a', index: 0, action: 'approve-all' });
  });

  it('respects initialIndex option', async () => {
    const { selectMenu } = loadMenu();

    const promise = selectMenu(
      [
        { label: 'Option A', value: 'a' },
        { label: 'Option B', value: 'b' },
        { label: 'Option C', value: 'c' },
      ],
      'Pick one',
      { initialIndex: 2 },
    );

    process.nextTick(() => {
      mockStdin.emit('data', '\r');
    });

    const result = await promise;
    expect(result).toEqual({ value: 'c', index: 2 });
  });
});
