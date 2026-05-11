import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A single UI sub-step and all the downstream HTTP/DB/console activity that
 * happened while it was running. This is the data shape the CLI (Phase 4) or
 * any future run-viewer will render as a correlated timeline.
 */
export interface UiTimelineEntry {
  stepIndex: number | null;
  subStepIndex: number | null;
  action: string; // sub-step kind (visit / click / type / ...)
  selector: string | null;
  message: string;
  startTimestamp: Date;
  endTimestamp: Date | null; // null if no matching COMPLETED/FAILED event found
  durationMs: number | null;
  status: 'success' | 'failed' | 'in-progress';
  error: string | null;
  children: UiTimelineChild[];
}

export type UiTimelineChild = (
  | {
      kind: 'http';
      timestamp: Date;
      method: string;
      url: string;
      statusCode: number | null;
      origin: string | null;
      target: string | null;
      isMocked: boolean | null;
    }
  | {
      kind: 'db';
      timestamp: Date;
      databaseType: string;
      databaseName: string;
      query: string;
      success: boolean;
      durationMs: number | null;
    }
) & {
  /**
   * Nested calls that this entry produced. For HTTP calls these are the
   * downstream calls the receiving service made (origin match + time
   * enclosure). For DB calls this is typically empty. See buildCallForest
   * for the parent-resolution algorithm.
   */
  children: UiTimelineChild[];
};

/**
 * Correlates UI sub-step boundary events with downstream HTTP and DB logs
 * captured from interceptor and db-proxy sidecars. Console logs are NOT
 * correlated here — service stdout (nginx access logs, postgres startup
 * chatter, etc.) is high-volume and rarely useful when debugging which
 * downstream call a UI sub-step caused. Use the dedicated console-log view
 * if you need it.
 *
 * Correlation model: for each `UI_SUBSTEP_STARTED` event, the window
 * `[startTs, nextStartTs)` (or `[startTs, runEnd]` for the last sub-step)
 * owns every log whose timestamp falls inside it. This is the same
 * timestamp-windowing pattern existing step-group correlation uses.
 *
 * Clock alignment caveat (see UI_E2E_TESTING.md): very fast downstream events
 * (<10 ms) can land in an adjacent window when cluster NTP skews. v1 does not
 * apply a grace window at boundaries — the CLI surfaces what the timestamps
 * say. A future improvement could stamp logs at CT ingest time instead of
 * sidecar-local time to collapse skew onto one clock.
 */
@Injectable()
export class UiTimelineService {
  private readonly logger = new Logger(UiTimelineService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getTimeline(instanceId: string): Promise<UiTimelineEntry[]> {
    // 1. All UI sub-step events for this instance, in timestamp order.
    const uiEvents = await this.prisma.testExecutionLog.findMany({
      where: {
        instanceId,
        eventType: {
          in: [
            'UI_SUBSTEP_STARTED',
            'UI_SUBSTEP_COMPLETED',
            'UI_SUBSTEP_FAILED',
          ],
        },
      },
      orderBy: { timestamp: 'asc' },
    });

    if (uiEvents.length === 0) {
      return [];
    }

    // 2. Pair STARTED events with their matching COMPLETED/FAILED by
    //    (stepIndex, subActionIndex, subStepIndex). Keep STARTED entries that
    //    never got a matching completion — status: 'in-progress'.
    type Started = (typeof uiEvents)[number];
    const startedEvents: Started[] = uiEvents.filter(
      (e) => e.eventType === 'UI_SUBSTEP_STARTED',
    );
    const completedBy = new Map<string, (typeof uiEvents)[number]>();
    for (const e of uiEvents) {
      if (
        e.eventType === 'UI_SUBSTEP_COMPLETED' ||
        e.eventType === 'UI_SUBSTEP_FAILED'
      ) {
        completedBy.set(keyFor(e), e);
      }
    }

    // Sort STARTEDs in strict timestamp order so the window between
    // consecutive starts is unambiguous.
    startedEvents.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    // 3. Build windows. Window N = [started_N.timestamp, started_{N+1}.timestamp).
    //    The last window extends to either the completion of that sub-step or
    //    now (so in-flight runs still correlate sensibly).
    const windowEndsAt = startedEvents.map((started, i) => {
      if (i + 1 < startedEvents.length) {
        return startedEvents[i + 1].timestamp;
      }
      const match = completedBy.get(keyFor(started));
      return match?.timestamp ?? null;
    });

    const earliestStart = startedEvents[0].timestamp;
    // Query downstream logs once, covering the entire span. We'll bucket them
    // in memory — avoids N DB round-trips for N sub-steps.
    const spanEnd = windowEndsAt[windowEndsAt.length - 1] ?? new Date();
    const [httpLogs, dbLogs] = await Promise.all([
      this.prisma.httpLog.findMany({
        where: { instanceId, timestamp: { gte: earliestStart, lt: spanEnd } },
        orderBy: { timestamp: 'asc' },
      }),
      this.prisma.databaseLog.findMany({
        where: { instanceId, timestamp: { gte: earliestStart, lt: spanEnd } },
        orderBy: { timestamp: 'asc' },
      }),
    ]);

    // 4. Bucket each downstream log into the latest window whose start <= ts.
    //    Binary search could be faster for huge runs; linear scan is fine for
    //    typical test sizes (<1000 logs per sub-step).
    const entries: UiTimelineEntry[] = startedEvents.map((started) =>
      buildEntry(started, completedBy.get(keyFor(started)) ?? null),
    );

    const windowIndexOf = (ts: Date): number => {
      for (let i = startedEvents.length - 1; i >= 0; i--) {
        if (ts >= startedEvents[i].timestamp) {
          const end = windowEndsAt[i];
          if (end === null || ts < end) {
            return i;
          }
        }
      }
      return -1;
    };

    // 4. Build the call forest from the HTTP+DB logs and bucket each top-level
    //    node (one without an inferable parent) into the UI sub-step whose
    //    window contains it. Nodes WITH a parent get attached inside the
    //    forest builder itself.
    const forest = buildCallForest(httpLogs, dbLogs);
    for (const top of forest) {
      const idx = windowIndexOf(new Date(top.startMs));
      if (idx === -1) {
        continue;
      }
      entries[idx].children.push(top.child);
    }

    return entries;
  }

  /**
   * Returns the call forest for a single test step (HTTP/DB step, no UI
   * sub-steps). The window is bracketed by the test-agent's group boundary
   * events so any HTTP/DB log that fired during the group is included. Each
   * returned node may itself have nested `children`.
   *
   * For groups with multiple parallel steps, this returns the union of all
   * top-level call trees in the group (we can't reliably attribute each call
   * to one of the parallel steps without trace IDs).
   */
  async getStepCallTree(
    instanceId: string,
    stepIndex: number,
  ): Promise<UiTimelineChild[]> {
    const stepEvents = await this.prisma.testExecutionLog.findMany({
      where: {
        instanceId,
        stepIndex,
        eventType: {
          in: [
            'REQUEST_STARTED',
            'REQUEST_COMPLETED',
            'REQUEST_FAILED',
            'STEP_STARTED',
            'STEP_COMPLETED',
            'STEP_FAILED',
          ],
        },
      },
      orderBy: { timestamp: 'asc' },
    });
    let startEvent = stepEvents.find((e) => e.eventType === 'REQUEST_STARTED');
    let endEvent = stepEvents.find(
      (e) =>
        e.eventType === 'REQUEST_COMPLETED' || e.eventType === 'REQUEST_FAILED',
    );
    if (!startEvent) {
      startEvent = stepEvents.find((e) => e.eventType === 'STEP_STARTED');
      endEvent =
        endEvent ??
        stepEvents.find(
          (e) =>
            e.eventType === 'STEP_COMPLETED' || e.eventType === 'STEP_FAILED',
        );
    }
    if (!startEvent) {
      return [];
    }

    const TIMESTAMP_BUFFER_MS = 100;
    const startTime = new Date(
      startEvent.timestamp.getTime() - TIMESTAMP_BUFFER_MS,
    );
    const endTime = new Date(
      (endEvent?.timestamp.getTime() ?? Date.now()) + TIMESTAMP_BUFFER_MS,
    );

    const [httpLogs, dbLogs] = await Promise.all([
      this.prisma.httpLog.findMany({
        where: { instanceId, timestamp: { gte: startTime, lt: endTime } },
        orderBy: { timestamp: 'asc' },
      }),
      this.prisma.databaseLog.findMany({
        where: { instanceId, timestamp: { gte: startTime, lt: endTime } },
        orderBy: { timestamp: 'asc' },
      }),
    ]);

    return buildCallForest(httpLogs, dbLogs).map((n) => n.child);
  }
}

// ---------------------------------------------------------------------------
// helpers — kept at module scope so the class body stays focused on flow
// ---------------------------------------------------------------------------

function keyFor(e: {
  stepIndex: number | null;
  subActionIndex: number | null;
  subStepIndex: number | null;
}): string {
  return `${e.stepIndex}:${e.subActionIndex}:${e.subStepIndex}`;
}

function buildEntry(
  started: {
    stepIndex: number | null;
    subActionIndex: number | null;
    subStepIndex: number | null;
    actionType: string | null;
    selector: string | null;
    message: string;
    timestamp: Date;
  },
  completion: {
    eventType: string;
    timestamp: Date;
    duration: number | null;
    error: string | null;
  } | null,
): UiTimelineEntry {
  return {
    stepIndex: started.stepIndex,
    subStepIndex: started.subStepIndex,
    action: started.actionType ?? 'unknown',
    selector: started.selector,
    message: started.message,
    startTimestamp: started.timestamp,
    endTimestamp: completion?.timestamp ?? null,
    durationMs: completion?.duration ?? null,
    status: !completion
      ? 'in-progress'
      : completion.eventType === 'UI_SUBSTEP_FAILED'
        ? 'failed'
        : 'success',
    error: completion?.error ?? null,
    children: [],
  };
}

/**
 * Builds the parent/child forest of HTTP+DB events from a flat list of logs.
 * Each event becomes a node with a `[startMs, endMs)` window. Nodes attach to
 * a parent when one is inferable:
 *
 *  - HTTP-to-HTTP nesting requires `target == origin` and time enclosure, so
 *    parallel branches don't get falsely nested into each other.
 *  - DB events fall back to pure time enclosure (most-deeply-nested HTTP
 *    open at the query timestamp), since DB logs don't carry an `origin`.
 *
 * Returns the top-level (parentless) nodes; nodes with parents have already
 * been attached into their parent's `child.children` array.
 */
type ForestNode = {
  child: UiTimelineChild;
  startMs: number;
  endMs: number; // POSITIVE_INFINITY when the call is still in flight
  origin: string | null;
  target: string | null;
};

function buildCallForest(
  httpLogs: Array<{
    timestamp: Date;
    method: string;
    url: string;
    statusCode: number | null;
    origin: string | null;
    target: string | null;
    isMocked: boolean | null;
    requestSentAt: Date | null;
    responseReceivedAt: Date | null;
  }>,
  dbLogs: Array<{
    timestamp: Date;
    databaseType: string;
    databaseName: string;
    query: string;
    success: boolean;
    duration: number | null;
  }>,
): ForestNode[] {
  const nodes: ForestNode[] = [];
  for (const h of httpLogs) {
    const start = h.requestSentAt ?? h.timestamp;
    const end = h.responseReceivedAt ?? null;
    nodes.push({
      child: {
        kind: 'http',
        timestamp: h.timestamp,
        method: h.method,
        url: h.url,
        statusCode: h.statusCode ?? null,
        origin: h.origin ?? null,
        target: h.target ?? null,
        isMocked: h.isMocked ?? null,
        children: [],
      },
      startMs: start.getTime(),
      endMs: end ? end.getTime() : Number.POSITIVE_INFINITY,
      origin: h.origin ?? null,
      target: h.target ?? null,
    });
  }
  for (const d of dbLogs) {
    const startMs = d.timestamp.getTime();
    nodes.push({
      child: {
        kind: 'db',
        timestamp: d.timestamp,
        databaseType: d.databaseType,
        databaseName: d.databaseName,
        query: d.query,
        success: d.success,
        durationMs: d.duration ?? null,
        children: [],
      },
      startMs,
      endMs: startMs + (d.duration ?? 0),
      origin: null,
      target: d.databaseName,
    });
  }
  nodes.sort((a, b) => a.startMs - b.startMs);

  const topLevel: ForestNode[] = [];
  for (const n of nodes) {
    let parent: ForestNode | null = null;
    for (const c of nodes) {
      if (c === n) {
        continue;
      }
      if (c.startMs > n.startMs) {
        continue;
      }
      if (c.endMs < n.startMs) {
        continue;
      }
      if (c.child.kind !== 'http') {
        continue;
      }
      if (n.child.kind === 'http') {
        if (n.origin === null) {
          continue;
        }
        if (c.target !== n.origin) {
          continue;
        }
      }
      if (parent === null || c.startMs > parent.startMs) {
        parent = c;
      }
    }
    if (parent) {
      parent.child.children.push(n.child);
    } else {
      topLevel.push(n);
    }
  }
  return topLevel;
}
