import { Logger } from '@nestjs/common';
import {
  is404Error,
  is409Error,
  shouldRetry,
  withRetry,
} from './kubernetes-helpers';

describe('kubernetes-helpers', () => {
  describe('is404Error', () => {
    it('returns true for error.code === 404', () => {
      expect(is404Error({ code: 404 })).toBe(true);
    });

    it('returns true for error.statusCode === 404', () => {
      expect(is404Error({ statusCode: 404 })).toBe(true);
    });

    it('returns true for error.body.code === 404', () => {
      expect(is404Error({ body: { code: 404 } })).toBe(true);
    });

    it('returns true for JSON string body with code 404', () => {
      expect(is404Error({ body: JSON.stringify({ code: 404 }) })).toBe(true);
    });

    it('returns false for non-404 error', () => {
      expect(is404Error({ code: 500 })).toBe(false);
    });

    it('returns false for invalid JSON body string', () => {
      expect(is404Error({ body: 'not-json' })).toBe(false);
    });

    it('returns false for empty object', () => {
      expect(is404Error({})).toBe(false);
    });
  });

  describe('is409Error', () => {
    it('returns true for error.code === 409', () => {
      expect(is409Error({ code: 409 })).toBe(true);
    });

    it('returns true for error.statusCode === 409', () => {
      expect(is409Error({ statusCode: 409 })).toBe(true);
    });

    it('returns true for error.body.code === 409', () => {
      expect(is409Error({ body: { code: 409 } })).toBe(true);
    });

    it('returns true for JSON string body with code 409', () => {
      expect(is409Error({ body: JSON.stringify({ code: 409 }) })).toBe(true);
    });

    it('returns false for non-409 error', () => {
      expect(is409Error({ code: 404 })).toBe(false);
    });

    it('returns false for invalid JSON body string', () => {
      expect(is409Error({ body: '{bad' })).toBe(false);
    });
  });

  describe('shouldRetry', () => {
    it('returns true for 500 status', () => {
      expect(shouldRetry({ statusCode: 500 })).toBe(true);
    });

    it('returns true for 503 status', () => {
      expect(shouldRetry({ statusCode: 503 })).toBe(true);
    });

    it('returns true when no statusCode and no body (network error)', () => {
      expect(shouldRetry({})).toBe(true);
    });

    it('returns false for 404', () => {
      expect(shouldRetry({ statusCode: 404 })).toBe(false);
    });

    it('returns false for 409', () => {
      expect(shouldRetry({ statusCode: 409 })).toBe(false);
    });

    it('returns false when body is present but statusCode < 500', () => {
      expect(shouldRetry({ statusCode: 400, body: { message: 'bad' } })).toBe(
        false,
      );
    });
  });

  describe('withRetry', () => {
    const logger = { warn: jest.fn() } as unknown as Logger;

    beforeEach(() => {
      jest.useFakeTimers();
      jest.clearAllMocks();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('returns result on first success', async () => {
      const op = jest.fn().mockResolvedValue('ok');

      const result = await withRetry(op, logger, 'test-op');

      expect(result).toBe('ok');
      expect(op).toHaveBeenCalledTimes(1);
    });

    it('retries on transient failure then succeeds', async () => {
      const op = jest
        .fn()
        .mockRejectedValueOnce({ statusCode: 500 })
        .mockResolvedValueOnce('ok');

      const promise = withRetry(op, logger, 'test-op');
      await jest.advanceTimersByTimeAsync(100);
      const result = await promise;

      expect(result).toBe('ok');
      expect(op).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('throws non-retryable errors immediately', async () => {
      const err = { statusCode: 404, body: { message: 'not found' } };
      const op = jest.fn().mockRejectedValue(err);

      await expect(withRetry(op, logger, 'test-op')).rejects.toBe(err);
      expect(op).toHaveBeenCalledTimes(1);
    });

    it('throws after max retries exhausted', async () => {
      const err = { statusCode: 500 };
      const op = jest.fn().mockRejectedValue(err);

      const promise = withRetry(op, logger, 'test-op', 3).catch(
        (e: unknown) => e,
      );
      await jest.advanceTimersByTimeAsync(100);
      await jest.advanceTimersByTimeAsync(200);
      const result = await promise;

      expect(result).toBe(err);
      expect(op).toHaveBeenCalledTimes(3);
    });

    it('uses exponential backoff delays', async () => {
      const op = jest
        .fn()
        .mockRejectedValueOnce({ statusCode: 500 })
        .mockRejectedValueOnce({ statusCode: 500 })
        .mockResolvedValueOnce('ok');

      const promise = withRetry(op, logger, 'test-op');

      await jest.advanceTimersByTimeAsync(100); // 2^0 * 100
      await jest.advanceTimersByTimeAsync(200); // 2^1 * 100
      await promise;

      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('retrying in 100ms'),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('retrying in 200ms'),
      );
    });
  });
});
