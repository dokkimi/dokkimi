import { fetchJson } from './cli-utils';
import { selectMenu, MenuItem } from './menu';
import type { LatestRunResponse, InstanceSummary } from './inspect-types';

function formatRunStatus(status: string): string {
  switch (status) {
    case 'COMPLETED':
      return '\x1b[32mPASSED\x1b[0m    ';
    case 'FAILED':
      return '\x1b[31mFAILED\x1b[0m    ';
    case 'CANCELLED':
      return '\x1b[33mCANCELLED\x1b[0m ';
    default:
      return `${status.padEnd(10)}`;
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case 'COMPLETED':
      return '\x1b[32m✓\x1b[0m';
    case 'FAILED':
      return '\x1b[31m✗\x1b[0m';
    case 'CANCELLED':
      return '\x1b[33m○\x1b[0m';
    default:
      return '\x1b[90m·\x1b[0m';
  }
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  const time = d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });

  if (diffMins < 1) {
    return 'just now';
  }
  if (diffMins < 60) {
    return `${diffMins}m ago`;
  }
  if (diffHours < 24 && d.getDate() === now.getDate()) {
    return `today ${time}`;
  }
  if (diffDays < 2) {
    return `yesterday ${time}`;
  }
  if (diffDays < 7) {
    return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  }

  return (
    d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
    }) + ` ${time}`
  );
}

export async function buildRunMenuItems(
  ctUrl: string,
  allRuns: LatestRunResponse[],
): Promise<MenuItem<LatestRunResponse>[]> {
  const pendingCounts = await fetchPendingCounts(ctUrl, allRuns);

  const byProject = new Map<string, LatestRunResponse[]>();
  for (const run of allRuns) {
    const key = run.projectPath ?? '(no project)';
    if (!byProject.has(key)) {
      byProject.set(key, []);
    }
    byProject.get(key)!.push(run);
  }

  const items: MenuItem<LatestRunResponse>[] = [];
  let first = true;
  for (const [project, runs] of byProject) {
    if (!first) {
      items.push({ label: '', value: null as any, disabled: true });
    }
    first = false;
    items.push({
      label: `\x1b[1m${project}\x1b[0m`,
      value: null as any,
      disabled: true,
    });
    const timestamps = runs.map((r) => formatTimestamp(r.createdAt));
    const maxTsLen = Math.max(...timestamps.map((t) => t.length));
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      const icon = statusIcon(run.status);
      const instanceCount = run.instances.length;
      const pending = pendingCounts.get(run.runId) ?? 0;
      const pendingTag =
        pending > 0
          ? `  ·  ${pending} baseline${pending !== 1 ? 's' : ''}`
          : '';
      const displayStatus = formatRunStatus(run.status);
      const label = `  ${icon} ${timestamps[i].padEnd(maxTsLen)}  ${displayStatus}  ${instanceCount} instance${instanceCount !== 1 ? 's' : ''}${pendingTag}`;
      items.push({ label, value: run });
    }
  }
  return items;
}

async function fetchPendingCounts(
  ctUrl: string,
  allRuns: LatestRunResponse[],
): Promise<Map<string, number>> {
  interface PendingResponse {
    pending: { id: string }[];
  }

  const counts = new Map<string, number>();
  const allInstances: { runId: string; instance: InstanceSummary }[] = [];
  for (const run of allRuns) {
    for (const inst of run.instances) {
      allInstances.push({ runId: run.runId, instance: inst });
    }
  }

  const results = await Promise.all(
    allInstances.map(({ instance }) =>
      fetchJson<PendingResponse>(
        `${ctUrl}/artifacts/instance/${instance.id}/baselines-pending`,
      ),
    ),
  );

  for (let i = 0; i < allInstances.length; i++) {
    const { runId } = allInstances[i];
    const pending = results[i]?.pending?.length ?? 0;
    counts.set(runId, (counts.get(runId) ?? 0) + pending);
  }

  return counts;
}

export async function fetchAllRuns(
  ctUrl: string,
): Promise<LatestRunResponse[] | null> {
  const runs = await fetchJson<LatestRunResponse[]>(
    `${ctUrl}/runs/history?limit=50`,
  );
  return runs && runs.length > 0 ? runs : null;
}

/**
 * Show the run picker and return the selected run, or null if the user exits.
 * Does NOT manage alt screen — caller is responsible.
 */
export async function pickRun(
  items: MenuItem<LatestRunResponse>[],
  title = 'Select a run:',
): Promise<LatestRunResponse | null> {
  const picked = await selectMenu(items, title);
  return picked ? picked.value : null;
}
