/* eslint-disable @typescript-eslint/no-require-imports */
describe('terminal', () => {
  let stdoutWriteSpy: jest.SpyInstance;

  beforeEach(() => {
    stdoutWriteSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    // Reset module state (altScreenActive) between tests
    jest.resetModules();
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
  });

  describe('enterAltScreen', () => {
    it('writes the alt-screen-enter ANSI escape sequence', () => {
      const { enterAltScreen } = require('./terminal');
      enterAltScreen();

      expect(stdoutWriteSpy).toHaveBeenCalledWith('\x1b[?1049h');
      // Also clears screen and moves cursor home
      expect(stdoutWriteSpy).toHaveBeenCalledWith('\x1b[2J\x1b[H');
    });
  });

  describe('exitAltScreen', () => {
    it('writes the alt-screen-exit ANSI escape sequence after enter', () => {
      const { enterAltScreen, exitAltScreen } = require('./terminal');
      enterAltScreen();
      stdoutWriteSpy.mockClear();

      exitAltScreen();

      expect(stdoutWriteSpy).toHaveBeenCalledWith('\x1b[?1049l');
    });

    it('does nothing if alt screen was not entered', () => {
      const { exitAltScreen } = require('./terminal');
      exitAltScreen();

      // Should not have written the exit sequence
      expect(stdoutWriteSpy).not.toHaveBeenCalledWith('\x1b[?1049l');
    });

    it('is idempotent — second call does nothing', () => {
      const { enterAltScreen, exitAltScreen } = require('./terminal');
      enterAltScreen();
      exitAltScreen();
      stdoutWriteSpy.mockClear();

      exitAltScreen();

      expect(stdoutWriteSpy).not.toHaveBeenCalled();
    });
  });

  describe('clearLines', () => {
    it('writes correct number of cursor-up + erase sequences for simple lines', () => {
      const { clearLines } = require('./terminal');

      // Stub isTTY and columns
      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'columns', {
        value: 80,
        configurable: true,
      });

      clearLines('line1\nline2\nline3');

      // 3 lines, each < 80 chars -> 3 visual lines -> 3 cursor-up+erase pairs
      const upEraseCalls = stdoutWriteSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === '\x1b[1A\x1b[2K',
      );
      expect(upEraseCalls).toHaveLength(3);
    });

    it('handles wrapping lines based on terminal width', () => {
      const { clearLines } = require('./terminal');

      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'columns', {
        value: 10,
        configurable: true,
      });

      // 20 visible chars in a 10-wide terminal = 2 visual lines
      clearLines('a'.repeat(20));

      const upEraseCalls = stdoutWriteSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === '\x1b[1A\x1b[2K',
      );
      expect(upEraseCalls).toHaveLength(2);
    });

    it('does nothing for empty string', () => {
      const { clearLines } = require('./terminal');

      clearLines('');

      expect(stdoutWriteSpy).not.toHaveBeenCalled();
    });

    it('does nothing when not a TTY', () => {
      const { clearLines } = require('./terminal');

      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        configurable: true,
      });

      clearLines('line1\nline2');

      const upEraseCalls = stdoutWriteSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === '\x1b[1A\x1b[2K',
      );
      expect(upEraseCalls).toHaveLength(0);
    });

    it('strips ANSI color codes when calculating visible length', () => {
      const { clearLines } = require('./terminal');

      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'columns', {
        value: 80,
        configurable: true,
      });

      // ANSI-colored text that is only 5 visible chars
      clearLines('\x1b[31mhello\x1b[0m');

      const upEraseCalls = stdoutWriteSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === '\x1b[1A\x1b[2K',
      );
      expect(upEraseCalls).toHaveLength(1);
    });
  });

  describe('waitForKey', () => {
    it('resolves on keypress', async () => {
      const { waitForKey } = require('./terminal');

      const mockSetRawMode = jest.fn();
      const mockResume = jest.fn();
      const mockPause = jest.fn();
      const listeners: Record<
        string | symbol,
        ((...args: unknown[]) => void)[]
      > = {};

      Object.defineProperty(process.stdin, 'setRawMode', {
        value: mockSetRawMode,
        configurable: true,
      });
      Object.defineProperty(process.stdin, 'resume', {
        value: mockResume,
        configurable: true,
      });
      Object.defineProperty(process.stdin, 'pause', {
        value: mockPause,
        configurable: true,
      });

      const _origOnce = process.stdin.once.bind(process.stdin);
      jest
        .spyOn(process.stdin, 'once')
        .mockImplementation(
          (event: string | symbol, cb: (...args: unknown[]) => void) => {
            if (!listeners[event]) {
              listeners[event] = [];
            }
            listeners[event].push(cb);
            return process.stdin;
          },
        );

      const promise = waitForKey();

      // Simulate a keypress
      const dataListeners = listeners['data'] ?? [];
      expect(dataListeners.length).toBe(1);
      dataListeners[0](Buffer.from('a'));

      await expect(promise).resolves.toBeUndefined();
      expect(mockSetRawMode).toHaveBeenCalledWith(true);
      expect(mockSetRawMode).toHaveBeenCalledWith(false);
      expect(mockPause).toHaveBeenCalled();

      (process.stdin.once as jest.Mock).mockRestore();
    });
  });

  describe('scrollableView', () => {
    it('returns "back" for non-TTY stdin', async () => {
      const { scrollableView } = require('./terminal');

      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        configurable: true,
      });

      const result = await scrollableView(['line 1', 'line 2'], 0, 1);
      expect(result).toBe('back');
    });

    it('shows pagination hints for content longer than terminal', async () => {
      const { scrollableView } = require('./terminal');

      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'rows', {
        value: 10,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'columns', {
        value: 80,
        configurable: true,
      });

      const longContent = Array.from({ length: 30 }, (_, i) => `line ${i}`);

      const mockSetRawMode = jest.fn();
      const mockResume = jest.fn();
      const mockSetEncoding = jest.fn();
      let dataHandler: ((key: string) => void) | null = null;

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
        .spyOn(process.stdin, 'pause')
        .mockImplementation(() => process.stdin);
      jest
        .spyOn(process.stdin, 'removeAllListeners')
        .mockImplementation(() => process.stdin);

      const promise = scrollableView(longContent, 0, 1);

      // Verify render was called (output written)
      expect(stdoutWriteSpy).toHaveBeenCalled();
      // Check pagination hint includes scroll indicator
      const lastWrite =
        stdoutWriteSpy.mock.calls[stdoutWriteSpy.mock.calls.length - 1][0];
      expect(lastWrite).toContain('scroll');

      // Press ESC to exit
      dataHandler!('\x1b');

      const result = await promise;
      expect(result).toBe('back');

      (process.stdin.on as jest.Mock).mockRestore();
      (process.stdin.pause as jest.Mock).mockRestore();
      (process.stdin.removeAllListeners as jest.Mock).mockRestore();
    });

    it('responds to down/up arrow keys', async () => {
      const { scrollableView } = require('./terminal');

      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'rows', {
        value: 10,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'columns', {
        value: 80,
        configurable: true,
      });

      const longContent = Array.from({ length: 30 }, (_, i) => `line ${i}`);

      const mockSetRawMode = jest.fn();
      const mockResume = jest.fn();
      const mockSetEncoding = jest.fn();
      let dataHandler: ((key: string) => void) | null = null;

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
        .spyOn(process.stdin, 'pause')
        .mockImplementation(() => process.stdin);
      jest
        .spyOn(process.stdin, 'removeAllListeners')
        .mockImplementation(() => process.stdin);

      const promise = scrollableView(longContent, 0, 1);

      // Press down arrow
      stdoutWriteSpy.mockClear();
      dataHandler!('\x1b[B');
      // Should have re-rendered
      expect(stdoutWriteSpy).toHaveBeenCalled();

      // Press up arrow
      stdoutWriteSpy.mockClear();
      dataHandler!('\x1b[A');
      expect(stdoutWriteSpy).toHaveBeenCalled();

      // Press ESC to exit
      dataHandler!('\x1b');
      const result = await promise;
      expect(result).toBe('back');

      (process.stdin.on as jest.Mock).mockRestore();
      (process.stdin.pause as jest.Mock).mockRestore();
      (process.stdin.removeAllListeners as jest.Mock).mockRestore();
    });
  });
});
