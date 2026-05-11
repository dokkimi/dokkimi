import { LoggingInterceptor } from './logging.interceptor';
import { of, throwError } from 'rxjs';
import { ExecutionContext, CallHandler } from '@nestjs/common';

describe('LoggingInterceptor', () => {
  let interceptor: LoggingInterceptor;
  let mockLogger: { log: jest.Mock; error: jest.Mock };
  let mockContext: ExecutionContext;
  let mockCallHandler: CallHandler;

  function createInterceptor() {
    return new (LoggingInterceptor as any)(mockLogger);
  }

  beforeEach(() => {
    mockLogger = { log: jest.fn(), error: jest.fn() };
    mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', url: '/test' }),
      }),
    } as any;
  });

  describe('successful request', () => {
    it('should not log on success', (done) => {
      interceptor = createInterceptor();

      mockCallHandler = { handle: () => of('result') };

      interceptor.intercept(mockContext, mockCallHandler).subscribe({
        complete: () => {
          expect(mockLogger.log).not.toHaveBeenCalled();
          done();
        },
      });
    });
  });

  describe('failed request', () => {
    it('should always log error with duration', (done) => {
      interceptor = createInterceptor();

      const error = new Error('something broke');
      mockCallHandler = { handle: () => throwError(() => error) };

      interceptor.intercept(mockContext, mockCallHandler).subscribe({
        error: () => {
          expect(mockLogger.error).toHaveBeenCalledWith(
            expect.stringMatching(
              /GET \/test - \d+ms - Error: something broke/,
            ),
            expect.stringContaining('something broke'),
          );
          done();
        },
      });
    });
  });
});
