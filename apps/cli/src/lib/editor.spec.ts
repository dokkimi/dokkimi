import * as os from 'os';
import * as path from 'path';
import type {
  HttpLog,
  DatabaseLog,
  ConsoleLog,
  TestExecutionLog,
} from './inspect-types';

jest.mock('fs');
jest.mock('@dokkimi/platform', () => ({
  openFile: jest.fn(),
}));

import * as fs from 'fs';
import { openFile as platformOpenFile } from '@dokkimi/platform';
import {
  stripIds,
  formatHttpLog,
  formatDbLog,
  formatTestExecutionLogs,
  formatConsoleLogs,
  formatPodLogs,
  openInEditor,
} from './editor';

describe('editor', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // stripIds
  // -------------------------------------------------------------------------

  describe('stripIds', () => {
    it('removes id, instanceId, instanceItemId from flat objects', () => {
      const result = stripIds({
        id: '1',
        instanceId: '2',
        instanceItemId: '3',
        name: 'keep',
      });
      expect(result).toEqual({ name: 'keep' });
    });

    it('handles nested objects recursively', () => {
      const result = stripIds({
        name: 'outer',
        child: { id: '1', value: 42 },
      });
      expect(result).toEqual({
        name: 'outer',
        child: { value: 42 },
      });
    });

    it('handles arrays of objects', () => {
      const result = stripIds([
        { id: '1', name: 'a' },
        { id: '2', name: 'b' },
      ]);
      expect(result).toEqual([{ name: 'a' }, { name: 'b' }]);
    });

    it('preserves non-id fields', () => {
      const result = stripIds({
        method: 'GET',
        url: '/api',
        statusCode: 200,
      });
      expect(result).toEqual({
        method: 'GET',
        url: '/api',
        statusCode: 200,
      });
    });

    it('handles null', () => {
      expect(stripIds(null)).toBeNull();
    });

    it('handles undefined', () => {
      expect(stripIds(undefined)).toBeUndefined();
    });

    it('handles primitives', () => {
      expect(stripIds(42)).toBe(42);
      expect(stripIds('hello')).toBe('hello');
      expect(stripIds(true)).toBe(true);
    });

    it('handles empty objects', () => {
      expect(stripIds({})).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // formatHttpLog
  // -------------------------------------------------------------------------

  describe('formatHttpLog', () => {
    it('transforms HttpLog into request/response structure', () => {
      const log: HttpLog = {
        id: '1',
        method: 'POST',
        url: '/api/users',
        statusCode: 201,
        origin: 'svc-a',
        target: 'svc-b',
        requestBody: { name: 'Alice' },
        responseBody: { id: '99' },
        requestHeaders: { 'content-type': 'application/json' },
        responseHeaders: { 'x-request-id': 'abc' },
        isMocked: false,
        requestSentAt: '2026-01-01T00:00:00Z',
        responseReceivedAt: '2026-01-01T00:00:01Z',
        duration: 1000,
      };

      const result = formatHttpLog(log);
      expect(result).toEqual({
        request: {
          method: 'POST',
          url: '/api/users',
          origin: 'svc-a',
          target: 'svc-b',
          headers: { 'content-type': 'application/json' },
          body: { name: 'Alice' },
          sentAt: '2026-01-01T00:00:00Z',
        },
        response: {
          statusCode: 201,
          headers: { 'x-request-id': 'abc' },
          body: { id: '99' },
          receivedAt: '2026-01-01T00:00:01Z',
        },
        duration: 1000,
        isMocked: false,
      });
    });
  });

  // -------------------------------------------------------------------------
  // formatDbLog
  // -------------------------------------------------------------------------

  describe('formatDbLog', () => {
    it('transforms DatabaseLog into flat structure', () => {
      const log: DatabaseLog = {
        id: 'db-1',
        instanceId: 'inst-1',
        instanceItemId: 'item-1',
        databaseType: 'postgres',
        databaseName: 'users_db',
        query: 'SELECT * FROM users',
        params: { limit: 10 },
        success: true,
        data: [{ id: '1', name: 'Alice' }],
        rowsAffected: 1,
        error: null,
        duration: 50,
        timestamp: '2026-01-01T00:00:00Z',
      };

      const result = formatDbLog(log);
      expect(result).toEqual({
        database: 'users_db',
        databaseType: 'postgres',
        query: 'SELECT * FROM users',
        params: { limit: 10 },
        success: true,
        data: [{ id: '1', name: 'Alice' }],
        rowsAffected: 1,
        error: null,
        duration: 50,
        timestamp: '2026-01-01T00:00:00Z',
      });
    });
  });

  // -------------------------------------------------------------------------
  // formatTestExecutionLogs
  // -------------------------------------------------------------------------

  describe('formatTestExecutionLogs', () => {
    it('returns empty message for empty array', () => {
      expect(formatTestExecutionLogs([])).toBe('(no test execution logs)\n');
    });

    it('formats logs with step info, subAction, duration, error', () => {
      const logs: TestExecutionLog[] = [
        {
          id: '1',
          instanceId: 'inst-1',
          eventType: 'STEP_START',
          message: 'Starting step',
          stepIndex: 0,
          subActionIndex: 1,
          subStepIndex: null,
          actionType: 'httpCall',
          selector: null,
          duration: 250,
          error: null,
          errorType: null,
          variables: {},
          timestamp: '2026-01-01T00:00:00Z',
        },
        {
          id: '2',
          instanceId: 'inst-1',
          eventType: 'STEP_FAIL',
          message: 'Step failed',
          stepIndex: 1,
          subActionIndex: null,
          subStepIndex: null,
          actionType: 'httpCall',
          selector: null,
          duration: null,
          error: 'Timeout exceeded',
          errorType: 'TIMEOUT',
          variables: {},
          timestamp: '2026-01-01T00:00:01Z',
        },
      ];

      const result = formatTestExecutionLogs(logs);
      expect(result).toContain('STEP_START');
      expect(result).toContain('[step 0]');
      expect(result).toContain('[subAction 1]');
      expect(result).toContain('(250ms)');
      expect(result).toContain('Starting step');
      expect(result).toContain('error: Timeout exceeded');
    });

    it('omits step/subAction/duration when null', () => {
      const logs: TestExecutionLog[] = [
        {
          id: '1',
          instanceId: 'inst-1',
          eventType: 'RUN_START',
          message: 'Run started',
          stepIndex: null,
          subActionIndex: null,
          subStepIndex: null,
          actionType: null,
          selector: null,
          duration: null,
          error: null,
          errorType: null,
          variables: {},
          timestamp: '2026-01-01T00:00:00Z',
        },
      ];

      const result = formatTestExecutionLogs(logs);
      expect(result).not.toContain('[step');
      expect(result).not.toContain('[subAction');
      expect(result).not.toContain('ms)');
      expect(result).not.toContain('error:');
    });
  });

  // -------------------------------------------------------------------------
  // formatConsoleLogs
  // -------------------------------------------------------------------------

  describe('formatConsoleLogs', () => {
    it('returns empty message for empty array', () => {
      expect(formatConsoleLogs([])).toBe('(no console logs)\n');
    });

    it('formats logs with timestamp, padded level, and ANSI-stripped message', () => {
      const logs: ConsoleLog[] = [
        {
          id: '1',
          instanceId: null,
          instanceItemId: null,
          level: 'info',
          message: '\x1b[32mGreen text\x1b[0m',
          timestamp: '2026-01-01T00:00:00Z',
        },
        {
          id: '2',
          instanceId: null,
          instanceItemId: null,
          level: 'warn',
          message: 'Plain warning',
          timestamp: '2026-01-01T00:00:01Z',
        },
      ];

      const result = formatConsoleLogs(logs);
      // Level padded to 5 chars
      expect(result).toContain('[info ]');
      expect(result).toContain('[warn ]');
      // ANSI codes stripped
      expect(result).toContain('Green text');
      expect(result).not.toContain('\x1b[32m');
    });
  });

  // -------------------------------------------------------------------------
  // formatPodLogs
  // -------------------------------------------------------------------------

  describe('formatPodLogs', () => {
    it('returns empty message for empty array with item name', () => {
      expect(formatPodLogs([], 'my-service')).toBe(
        '(no pod logs captured for my-service)\n',
      );
    });

    it('strips [item:...] prefix from messages and joins with separator', () => {
      const logs: TestExecutionLog[] = [
        {
          id: '1',
          instanceId: 'inst-1',
          eventType: 'POD_LOG',
          message: '[item:svc-a] [pod:pod-1] Hello from pod',
          stepIndex: null,
          subActionIndex: null,
          subStepIndex: null,
          actionType: null,
          selector: null,
          duration: null,
          error: null,
          errorType: null,
          variables: {},
          timestamp: '2026-01-01T00:00:00Z',
        },
        {
          id: '2',
          instanceId: 'inst-1',
          eventType: 'POD_LOG',
          message: '[item:svc-a] Second line',
          stepIndex: null,
          subActionIndex: null,
          subStepIndex: null,
          actionType: null,
          selector: null,
          duration: null,
          error: null,
          errorType: null,
          variables: {},
          timestamp: '2026-01-01T00:00:01Z',
        },
      ];

      const result = formatPodLogs(logs, 'svc-a');
      expect(result).toContain('[pod:pod-1] Hello from pod');
      expect(result).toContain('Second line');
      expect(result).not.toContain('[item:svc-a]');
      // Separator between entries
      expect(result).toContain('='.repeat(60));
    });
  });

  // -------------------------------------------------------------------------
  // openInEditor
  // -------------------------------------------------------------------------

  describe('openInEditor', () => {
    it('creates temp dir, writes JSON-stringified file for objects, calls openFile', () => {
      const mkdirSyncMock = fs.mkdirSync as jest.MockedFunction<
        typeof fs.mkdirSync
      >;
      const writeFileSyncMock = fs.writeFileSync as jest.MockedFunction<
        typeof fs.writeFileSync
      >;
      const openFileMock = platformOpenFile as jest.MockedFunction<
        typeof platformOpenFile
      >;

      const data = { key: 'value' };
      openInEditor(data, 'test.json');

      const expectedDir = path.join(os.tmpdir(), 'dokkimi-inspect');
      expect(mkdirSyncMock).toHaveBeenCalledWith(expectedDir, {
        recursive: true,
      });

      const expectedPath = path.join(expectedDir, 'test.json');
      expect(writeFileSyncMock).toHaveBeenCalledWith(
        expectedPath,
        JSON.stringify(data, null, 2),
      );
      expect(openFileMock).toHaveBeenCalledWith(expectedPath);
    });

    it('writes raw string for string data', () => {
      const writeFileSyncMock = fs.writeFileSync as jest.MockedFunction<
        typeof fs.writeFileSync
      >;

      openInEditor('raw text content', 'log.txt');

      const expectedPath = path.join(os.tmpdir(), 'dokkimi-inspect', 'log.txt');
      expect(writeFileSyncMock).toHaveBeenCalledWith(
        expectedPath,
        'raw text content',
      );
    });
  });
});
