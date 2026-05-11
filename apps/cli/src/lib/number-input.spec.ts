describe('numberInput', () => {
  let stdoutWriteSpy: jest.SpyInstance;
  let dataHandler: ((key: string) => void) | null = null;

  beforeEach(() => {
    jest.resetModules();
    stdoutWriteSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });

    const mockSetRawMode = jest.fn();
    const mockResume = jest.fn();
    const mockSetEncoding = jest.fn();
    const mockPause = jest.fn();

    Object.defineProperty(process.stdin, 'setRawMode', {
      value: mockSetRawMode,
      configurable: true,
    });
    Object.defineProperty(process.stdin, 'resume', {
      value: mockResume,
      configurable: true,
    });
    Object.defineProperty(process.stdin, 'setEncoding', {
      value: mockSetEncoding,
      configurable: true,
    });
    Object.defineProperty(process.stdin, 'pause', {
      value: mockPause,
      configurable: true,
    });

    jest
      .spyOn(process.stdin, 'on')
      .mockImplementation(
        (event: string | symbol, cb: (...args: unknown[]) => void) => {
          if (event === 'data') {
            dataHandler = cb as (key: string) => void;
          }
          return process.stdin;
        },
      );
    jest
      .spyOn(process.stdin, 'removeAllListeners')
      .mockImplementation(() => process.stdin);
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    (process.stdin.on as jest.Mock).mockRestore();
    (process.stdin.removeAllListeners as jest.Mock).mockRestore();
    dataHandler = null;
  });

  it('returns number on enter', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { numberInput } = require('./number-input');

    // numberInput initializes value = String(current), so start value is "5"
    const promise = numberInput('Pick a number', 5);

    // Just press enter to confirm the current value
    dataHandler!('\r');

    const result = await promise;
    expect(result).toBe(5);
  });

  it('enforces min/max bounds - returns null when out of range', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { numberInput } = require('./number-input');

    // Start value is "5", typing "99" makes it "599" which is > max 10
    const promise = numberInput('Pick a number', 5, { min: 1, max: 10 });

    dataHandler!('9');
    dataHandler!('9');
    dataHandler!('\r');

    const result = await promise;
    expect(result).toBeNull();
  });

  it('enforces min bound - returns null when below min', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { numberInput } = require('./number-input');

    // Start value "5", clear it, type "3" -> below min 10
    const promise = numberInput('Pick a number', 5, { min: 10, max: 100 });

    dataHandler!('\x7f'); // backspace -> ""
    dataHandler!('3'); // -> "3"
    dataHandler!('\r');

    const result = await promise;
    expect(result).toBeNull();
  });

  it('ignores non-numeric input', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { numberInput } = require('./number-input');

    // Start value "5", clear it, type letters (ignored), then valid number
    const promise = numberInput('Pick a number', 5);

    dataHandler!('\x7f'); // backspace -> ""
    dataHandler!('a'); // ignored
    dataHandler!('b'); // ignored
    dataHandler!('7'); // -> "7"
    dataHandler!('\r');

    const result = await promise;
    expect(result).toBe(7);
  });

  it('backspace works', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { numberInput } = require('./number-input');

    // Start value "5", type "12" -> "512", backspace -> "51", type "3" -> "513"
    // Actually let's clear first and test backspace on typed content
    const promise = numberInput('Pick a number', 5);

    dataHandler!('\x7f'); // backspace -> ""
    dataHandler!('1'); // -> "1"
    dataHandler!('2'); // -> "12"
    dataHandler!('\x7f'); // backspace -> "1"
    dataHandler!('3'); // -> "13"
    dataHandler!('\r');

    const result = await promise;
    expect(result).toBe(13);
  });

  it('escape returns null', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { numberInput } = require('./number-input');

    const promise = numberInput('Pick a number', 5);

    dataHandler!('\x1b');

    const result = await promise;
    expect(result).toBeNull();
  });

  it('returns null for non-TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { numberInput } = require('./number-input');

    const result = await numberInput('Pick a number', 5);
    expect(result).toBeNull();
  });
});
