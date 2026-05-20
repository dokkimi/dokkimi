import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getConcurrencyPrefs,
  setConcurrencyPrefs,
  getKubeconfigPrefs,
  setKubeconfigPrefs,
  getTelemetryPrefs,
  setTelemetryPrefs,
} from '@dokkimi/config';

const DEFAULT_MAX_NAMESPACES = 6;
const DEFAULT_MAX_BOOTING = 2;

const SETTINGS_REQUIRING_REBOOT = new Set([
  'maxNamespaces',
  'maxBooting',
  'context',
]);

export function registerGetConfig(server: McpServer): void {
  server.tool(
    'get_config',
    'Returns all current Dokkimi settings and their defaults.',
    {},
    async () => {
      const concurrency = getConcurrencyPrefs();
      const kubeconfig = getKubeconfigPrefs();
      const telemetry = getTelemetryPrefs();

      const config = {
        maxNamespaces: {
          value: concurrency.maxNamespaces ?? DEFAULT_MAX_NAMESPACES,
          default: DEFAULT_MAX_NAMESPACES,
          isDefault: concurrency.maxNamespaces === undefined,
        },
        maxBooting: {
          value: concurrency.maxBooting ?? DEFAULT_MAX_BOOTING,
          default: DEFAULT_MAX_BOOTING,
          isDefault: concurrency.maxBooting === undefined,
        },
        context: {
          value: kubeconfig.context ?? 'default',
          default: 'default',
          isDefault: kubeconfig.context === undefined,
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
    'Updates a Dokkimi setting. Changes to maxNamespaces, maxBooting, and context require a reboot to take effect — call the reboot tool separately after updating.',
    {
      key: z
        .enum(['maxNamespaces', 'maxBooting', 'context', 'telemetry'])
        .describe('The setting to change.'),
      value: z
        .union([z.number(), z.string(), z.boolean()])
        .describe(
          'The new value. Numbers for maxNamespaces/maxBooting, string for context, boolean for telemetry.',
        ),
    },
    async ({ key, value }) => {
      try {
        switch (key) {
          case 'maxNamespaces': {
            if (typeof value !== 'number' || value < 1 || value > 50) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      error: 'maxNamespaces must be a number between 1 and 50',
                    }),
                  },
                ],
                isError: true,
              };
            }
            const prefs = getConcurrencyPrefs();
            setConcurrencyPrefs({
              ...prefs,
              maxNamespaces:
                value === DEFAULT_MAX_NAMESPACES ? undefined : value,
            });
            break;
          }
          case 'maxBooting': {
            if (typeof value !== 'number' || value < 1 || value > 50) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      error: 'maxBooting must be a number between 1 and 50',
                    }),
                  },
                ],
                isError: true,
              };
            }
            const prefs = getConcurrencyPrefs();
            setConcurrencyPrefs({
              ...prefs,
              maxBooting: value === DEFAULT_MAX_BOOTING ? undefined : value,
            });
            break;
          }
          case 'context': {
            if (typeof value !== 'string') {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      error: 'context must be a string',
                    }),
                  },
                ],
                isError: true,
              };
            }
            if (value === 'default' || value === '') {
              setKubeconfigPrefs({});
            } else {
              setKubeconfigPrefs({ context: value });
            }
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
