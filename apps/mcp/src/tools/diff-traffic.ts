import * as path from 'path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ctFetch } from '../lib/ct-client';
import { findDokkimiDir } from '../lib/dokkimi-dir';
import type {
  LatestRunResponse,
  HttpLog,
  PaginatedResponse,
} from '../lib/ct-types';

interface TrafficFingerprint {
  method: string;
  url: string;
  origin: string | null;
  target: string | null;
}

function fingerprint(log: HttpLog): string {
  return `${log.method ?? ''}|${log.url ?? ''}|${log.origin ?? ''}|${log.target ?? ''}`;
}

export function registerDiffTraffic(server: McpServer): void {
  server.tool(
    'diff_traffic',
    'Compares HTTP traffic between two runs of the same definition. Shows requests that appeared, disappeared, or changed status code between runs. Useful for understanding what changed when a test starts failing. Requires two runs in history for the same definition.',
    {
      definitionName: z
        .string()
        .describe(
          'Definition name to compare traffic for (e.g. "my-api-tests")',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe(
          'Maximum number of traffic logs to fetch per run (default: 500)',
        ),
    },
    async ({ definitionName, limit }) => {
      try {
        const dokkimiDir = findDokkimiDir(process.cwd());
        const projectPath = dokkimiDir ? path.dirname(dokkimiDir) : undefined;

        const runs = await ctFetch<LatestRunResponse[]>('/runs/history', {
          ...(projectPath ? { projectPath } : {}),
          limit: '10',
        });

        const matchingRuns = runs.filter((r) =>
          r.instances.some((i) => i.name === definitionName),
        );

        if (matchingRuns.length < 2) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    error: `Need at least 2 runs with definition "${definitionName}" to diff. Found ${matchingRuns.length}.`,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }

        const [currentRun, previousRun] = matchingRuns;
        const currentInst = currentRun.instances.find(
          (i) => i.name === definitionName,
        )!;
        const previousInst = previousRun.instances.find(
          (i) => i.name === definitionName,
        )!;

        const fetchLimit = String(limit ?? 500);
        const [currentTraffic, previousTraffic] = await Promise.all([
          ctFetch<PaginatedResponse<HttpLog>>(
            `/logs/http/instance/${currentInst.id}`,
            { limit: fetchLimit },
          ),
          ctFetch<PaginatedResponse<HttpLog>>(
            `/logs/http/instance/${previousInst.id}`,
            { limit: fetchLimit },
          ),
        ]);

        const currentByFp = new Map<string, HttpLog[]>();
        for (const log of currentTraffic.logs) {
          const fp = fingerprint(log);
          const existing = currentByFp.get(fp) ?? [];
          existing.push(log);
          currentByFp.set(fp, existing);
        }

        const previousByFp = new Map<string, HttpLog[]>();
        for (const log of previousTraffic.logs) {
          const fp = fingerprint(log);
          const existing = previousByFp.get(fp) ?? [];
          existing.push(log);
          previousByFp.set(fp, existing);
        }

        const allFps = new Set([...currentByFp.keys(), ...previousByFp.keys()]);

        const added: TrafficFingerprint[] = [];
        const removed: TrafficFingerprint[] = [];
        const statusChanged: {
          method: string;
          url: string;
          origin: string | null;
          target: string | null;
          previousStatus: number | null;
          currentStatus: number | null;
        }[] = [];

        for (const fp of allFps) {
          const curr = currentByFp.get(fp);
          const prev = previousByFp.get(fp);

          if (curr && !prev) {
            const log = curr[0];
            added.push({
              method: log.method,
              url: log.url,
              origin: log.origin,
              target: log.target,
            });
          } else if (!curr && prev) {
            const log = prev[0];
            removed.push({
              method: log.method,
              url: log.url,
              origin: log.origin,
              target: log.target,
            });
          } else if (curr && prev) {
            const currStatus = curr[0].statusCode;
            const prevStatus = prev[0].statusCode;
            if (currStatus !== prevStatus) {
              statusChanged.push({
                method: curr[0].method,
                url: curr[0].url,
                origin: curr[0].origin,
                target: curr[0].target,
                previousStatus: prevStatus,
                currentStatus: currStatus,
              });
            }
          }
        }

        const result = {
          definition: definitionName,
          currentRun: {
            runId: currentRun.runId,
            status: currentRun.status,
            createdAt: currentRun.createdAt,
            instanceStatus: currentInst.testStatus ?? currentInst.status,
            trafficCount: currentTraffic.total,
          },
          previousRun: {
            runId: previousRun.runId,
            status: previousRun.status,
            createdAt: previousRun.createdAt,
            instanceStatus: previousInst.testStatus ?? previousInst.status,
            trafficCount: previousTraffic.total,
          },
          diff: {
            added,
            removed,
            statusChanged,
          },
        };

        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  error:
                    err instanceof Error
                      ? err.message
                      : 'Failed to diff traffic',
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
