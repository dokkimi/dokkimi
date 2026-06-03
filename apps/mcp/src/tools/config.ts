import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getConcurrencyPrefs,
  setConcurrencyPrefs,
  getTelemetryPrefs,
  setTelemetryPrefs,
} from '@dokkimi/config';

const DEFAULT_MAX_CONCURRENT_TESTS = 6;
const DEFAULT_MAX_BOOTING_TESTS = 2;

const SETTINGS_REQUIRING_REBOOT = new Set([
  'maxConcurrentTests',
  'maxBootingTests',
]);

export function registerGetConfig(server: McpServer): void {
  server.tool(
    'get_config',
    'Returns all current Dokkimi settings and their defaults.',
    {},
    async () => {
      const concurrency = getConcurrencyPrefs();
      const telemetry = getTelemetryPrefs();

      const config = {
        maxConcurrentTests: {
          value: concurrency.maxConcurrentTests ?? DEFAULT_MAX_CONCURRENT_TESTS,
          default: DEFAULT_MAX_CONCURRENT_TESTS,
          isDefault: concurrency.maxConcurrentTests === undefined,
        },
        maxBootingTests: {
          value: concurrency.maxBootingTests ?? DEFAULT_MAX_BOOTING_TESTS,
          default: DEFAULT_MAX_BOOTING_TESTS,
          isDefault: concurrency.maxBootingTests === undefined,
        },
        telemetry: {
          value: telemetry?.enabled ?? true,
          default: true,
          isDefault: telemetry?.enabled === undefined,
        },
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(config, null, 2) }],
      };
    },
  );
}

export function registerSetConfig(server: McpServer): void {
  server.tool(
    'set_config',
    'Updates a Dokkimi setting. Changes to maxConcurrentTests and maxBootingTests require a reboot to take effect — call the reboot tool separately after updating.',
    {
      key: z
        .enum(['maxConcurrentTests', 'maxBootingTests', 'telemetry'])
        .describe('The setting to change.'),
      value: z
        .union([z.number(), z.boolean()])
        .describe(
          'The new value. Numbers for maxConcurrentTests/maxBootingTests, boolean for telemetry.',
        ),
    },
    async ({ key, value }) => {
      try {
        switch (key) {
          case 'maxConcurrentTests': {
            if (typeof value !== 'number' || value < 1 || value > 50) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      error:
                        'maxConcurrentTests must be a number between 1 and 50',
                    }),
                  },
                ],
                isError: true,
              };
            }
            const prefs = getConcurrencyPrefs();
            setConcurrencyPrefs({
              ...prefs,
              maxConcurrentTests:
                value === DEFAULT_MAX_CONCURRENT_TESTS ? undefined : value,
            });
            break;
          }
          case 'maxBootingTests': {
            if (typeof value !== 'number' || value < 1 || value > 50) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      error:
                        'maxBootingTests must be a number between 1 and 50',
                    }),
                  },
                ],
                isError: true,
              };
            }
            const prefs = getConcurrencyPrefs();
            setConcurrencyPrefs({
              ...prefs,
              maxBootingTests:
                value === DEFAULT_MAX_BOOTING_TESTS ? undefined : value,
            });
            break;
          }
          case 'telemetry': {
            if (typeof value !== 'boolean') {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      error: 'telemetry must be a boolean',
                    }),
                  },
                ],
                isError: true,
              };
            }
            const current = getTelemetryPrefs();
            setTelemetryPrefs({
              distinctId: current?.distinctId ?? '',
              enabled: value,
              firstRunNoticeSeen: current?.firstRunNoticeSeen ?? true,
            });
            break;
          }
        }

        const needsReboot = SETTINGS_REQUIRING_REBOOT.has(key);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                key,
                value,
                ...(needsReboot
                  ? {
                      needsReboot: true,
                      message:
                        'Setting updated. Call the reboot tool to apply changes.',
                    }
                  : { message: 'Setting updated.' }),
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: `Failed to update setting: ${err instanceof Error ? err.message : String(err)}`,
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
