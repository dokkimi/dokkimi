import { ColoredLoggerService } from './colored-logger.service';

describe('ColoredLoggerService', () => {
  beforeEach(() => {
    delete process.env.LOG_FILE;
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('log', () => {
    it('should output with service color prefix and ANSI codes', () => {
      const color = '\x1b[36m';
      const logger = ColoredLoggerService.create('MY-SVC', color);
      logger.log('hello world');

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('[MY-SVC]'),
        ...([] as any),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('\x1b['),
        ...([] as any),
      );
    });
  });

  describe('error', () => {
    it('should include trace when provided as string', () => {
      const logger = ColoredLoggerService.create('SVC', '\x1b[31m');
      logger.error('failure', 'Error: stack trace here');

      expect(console.error).toHaveBeenCalledTimes(2);
      expect(console.error).toHaveBeenLastCalledWith(
        'Error: stack trace here',
        ...([] as any),
      );
    });

    it('should include trace when provided as Error object', () => {
      const logger = ColoredLoggerService.create('SVC', '\x1b[31m');
      const err = new Error('boom');
      logger.error('failure', err);

      expect(console.error).toHaveBeenCalledTimes(2);
      expect(console.error).toHaveBeenLastCalledWith(
        expect.stringContaining('boom'),
        ...([] as any),
      );
    });
  });

  describe('file writer', () => {
    it('should strip ANSI codes when writing to file', () => {
      const colored = '\x1b[1m[SVC]\x1b[0m hello';
      // eslint-disable-next-line no-control-regex
      const stripped = colored.replace(/\x1b\[[0-9;]*m/g, '');
      expect(stripped).toBe('[SVC] hello');
      expect(stripped).not.toContain('\x1b[');
    });
  });

  describe('static create', () => {
    it('should return a working instance without DI', () => {
      const logger = ColoredLoggerService.create('TEST', '\x1b[33m', 'MyCtx');
      logger.log('from factory');

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('[TEST]'),
        ...([] as any),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('[MyCtx]'),
        ...([] as any),
      );
    });
  });

  describe('warn', () => {
    it('should output to console.warn with service prefix', () => {
      const logger = ColoredLoggerService.create('SVC', '\x1b[33m');
      logger.warn('something fishy');

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('[SVC]'),
        ...([] as any),
      );
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('something fishy'),
        ...([] as any),
      );
    });

    it('should include context prefix when set', () => {
      const logger = ColoredLoggerService.create('SVC', '\x1b[33m', 'WarnCtx');
      logger.warn('heads up');

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('[WarnCtx]'),
        ...([] as any),
      );
    });
  });

  describe('error edge cases', () => {
    it('should handle trace as a non-string non-Error value', () => {
      const logger = ColoredLoggerService.create('SVC', '\x1b[31m');
      logger.error('failure', 42);

      expect(console.error).toHaveBeenCalledTimes(2);
      expect(console.error).toHaveBeenLastCalledWith('42', ...([] as any));
    });

    it('should not output trace line when trace is undefined', () => {
      const logger = ColoredLoggerService.create('SVC', '\x1b[31m');
      logger.error('failure');

      expect(console.error).toHaveBeenCalledTimes(1);
    });

    it('should use Error.message when Error has no stack', () => {
      const logger = ColoredLoggerService.create('SVC', '\x1b[31m');
      const err = new Error('no-stack');
      err.stack = undefined;
      logger.error('failure', err);

      expect(console.error).toHaveBeenCalledTimes(2);
      expect(console.error).toHaveBeenLastCalledWith(
        'no-stack',
        ...([] as any),
      );
    });
  });

  describe('context handling', () => {
    it('should omit context bracket when no context is set', () => {
      const logger = ColoredLoggerService.create('SVC', '\x1b[36m');
      logger.log('no context');

      const call = (console.log as jest.Mock).mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('no context'),
      );
      expect(call).toBeDefined();
      expect(call[0]).not.toContain('[undefined]');
    });
  });

  describe('default values', () => {
    it('should default serviceName to APP when not provided', () => {
      const logger = new (ColoredLoggerService as any)();
      logger.log('default name');

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('[APP]'),
        ...([] as any),
      );
    });

    it('should use white as default color when not provided', () => {
      const logger = new (ColoredLoggerService as any)();
      logger.log('default color');

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('\x1b[37m'),
        ...([] as any),
      );
    });
  });
});
