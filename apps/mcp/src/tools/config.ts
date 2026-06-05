import * as path from 'path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getConcurrencyPrefs,
  setConcurrencyPrefs,
  getTelemetryPrefs,
  setTelemetryPrefs,
  getMaxRunHistory,
  setMaxRunHistory,
  getUserPrefs,
} from '@dokkimi/config';
import { findDokkimiDir } from '../lib/dokkimi-dir';

const DEFAULT_MAX_CONCURRENT_TESTS = 6;
const DEFAULT_MAX_BOOTING_TESTS = 2;
const DEFAULT_MAX_RUN_HISTORY = 2;

const SETTINGS_REQUIRING_REBOOT = new Set([
  'maxConcurrentTests',
  'maxBootingTests',
]);

function resolveProjectPath(): string | undefined {
  const dokkimiDir = findDokkimiDir(process.cwd());
  return dokkimiDir ? path.dirname(dokkimiDir) : undefined;
}

function resolveSource(
  key: string,
  projectPath: string | undefined,
): 'project' | 'global' | 'default' {
  const prefs = getUserPrefs();

  if (projectPath) {
    const proj = prefs.projects?.[projectPath];
    if (proj) {
      if (key === 'maxRunHistory' && proj.maxRunHistory !== undefined) {
        return 'project';
      }
      if (
        (key === 'maxConcurrentTests' || key === 'maxBootingTests') &&
        proj.concurrency?.[key] !== undefined
      ) {
        return 'project';
      }
    }
  }

  if (key === 'maxRunHistory' && prefs.maxRunHistory !== undefined) {
    return 'global';
  }
  if (
    (key === 'maxConcurrentTests' || key === 'maxBootingTests') &&
    prefs.concurrency?.[key] !== undefined
  ) {
    return 'global';
  }
  if (key === 'telemetry' && prefs.telemetry?.enabled !== undefined) {
    return 'global';
  }

  return 'default';
}

export function registerGetConfig(server: McpServer): void {
  server.tool(
    'get_config',
    'Returns all current Dokkimi settings with their defaults and source (project override, global, or default). Automatically detects the current project from the working directory.',
    {},
    async () => {
      const projectPath = resolveProjectPath();
      const concurrency = getConcurrencyPrefs(projectPath);
      const telemetry = getTelemetryPrefs();
      const maxRunHistory = getMaxRunHistory(projectPath);

      const config: Record<string, unknown> = {
        ...(projectPath ? { projectPath } : {}),
        maxConcurrentTests: {
          value: concurrency.maxConcurrentTests ?? DEFAULT_MAX_CONCURRENT_TESTS,
          default: DEFAULT_MAX_CONCURRENT_TESTS,
          source: resolveSource('maxConcurrentTests', projectPath),
        },
        maxBootingTests: {
          value: concurrency.maxBootingTests ?? DEFAULT_MAX_BOOTING_TESTS,
          default: DEFAULT_MAX_BOOTING_TESTS,
          source: resolveSource('maxBootingTests', projectPath),
        },
        maxRunHistory: {
          value: maxRunHistory,
          default: DEFAULT_MAX_RUN_HISTORY,
          source: resolveSource('maxRunHistory', projectPath),
        },
        telemetry: {
          value: telemetry?.enabled ?? true,
          default: true,
          source: resolveSource('telemetry', projectPath),
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
    'Updates a Dokkimi setting. Use the scope parameter to target project-level or global config. Changes to maxConcurrentTests and maxBootingTests require a reboot to take effect — call the reboot tool separately after updating.',
    {
      key: z
        .enum([
          'maxConcurrentTests',
          'maxBootingTests',
          'maxRunHistory',
          'telemetry',
        ])
        .describe('The setting to change.'),
      value: z
        .union([z.number(), z.boolean()])
        .describe(
          'The new value. Numbers for maxConcurrentTests/maxBootingTests/maxRunHistory, boolean for telemetry.',
        ),
      scope: z
        .enum(['project', 'global'])
        .optional()
        .describe(
          'Where to save the setting. Defaults to "project" when inside a project directory, otherwise "global". Telemetry is always global.',
        ),
    },
    async ({ key, value, scope }) => {
      try {
        const projectPath = resolveProjectPath();
        const effectiveScope =
          key === 'telemetry'
            ? 'global'
            : (scope ?? (projectPath ? 'project' : 'global'));

        if (effectiveScope === 'project' && !projectPath) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error:
                    'No .dokkimi/ directory found — cannot set project-level config. Use scope: "global" or run from inside a project.',
                }),
              },
            ],
            isError: true,
          };
        }

        const targetPath =
          effectiveScope === 'project' ? projectPath : undefined;

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
            const prefs = getConcurrencyPrefs(targetPath);
            setConcurrencyPrefs(
              {
                ...prefs,
                maxConcurrentTests:
                  value === DEFAULT_MAX_CONCURRENT_TESTS ? undefined : value,
              },
              targetPath,
            );
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
            const prefs = getConcurrencyPrefs(targetPath);
            setConcurrencyPrefs(
              {
                ...prefs,
                maxBootingTests:
                  value === DEFAULT_MAX_BOOTING_TESTS ? undefined : value,
              },
              targetPath,
            );
            break;
          }
          case 'maxRunHistory': {
            if (typeof value !== 'number' || value < 1 || value > 100) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      error: 'maxRunHistory must be a number between 1 and 100',
                    }),
                  },
                ],
                isError: true,
              };
            }
            setMaxRunHistory(
              value === DEFAULT_MAX_RUN_HISTORY ? undefined : value,
              targetPath,
            );
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
                scope: effectiveScope,
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
