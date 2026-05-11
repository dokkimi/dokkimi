import type { UiTimelineEntry, UiTimelineChild } from './inspect-types';

// Terminal ANSI codes — match the palette already used in formatAssertionReport.
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[90m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

/**
 * Renders the correlated UI timeline returned by
 * `GET /logs/ui-timeline/instance/:instanceId` as a tree suitable for
 * `scrollableView`. One entry per UI sub-step; downstream HTTP / DB / console
 * events appear as children.
 *
 * Shape produced (example):
 *
 *   checkout-e2e — step 2 · add-to-cart-and-checkout        1.8s
 *     ✓ click   [data-testid='add-to-cart']                 42ms
 *       ├─ HTTP  POST  cart-svc /cart/items                89ms  ✓ 201
 *       └─ DB    INSERT cart_items (cart-svc)               3ms  ✓
 *     ✓ waitFor cart-count=1                              120ms
 *     ✓ click   [data-testid='checkout-btn']                38ms
 *       ├─ HTTP  POST  order-svc /orders                  340ms  ✓ 201
 *       ├─ DB    INSERT orders (order-svc)                  8ms  ✓
 *       └─ DB    UPDATE stock  (inventory-svc)              5ms  ✓
 *     ✗ waitFor #receipt                   TIMEOUT after 500ms
 */
export interface TimelineRoot {
  /** "Step 1.2" — the step's 1-based label. */
  stepLabel: string;
  /** Human-readable step name from the YAML (or '' if unset). */
  stepName: string;
}

export function formatUiTimeline(
  title: string,
  root: TimelineRoot,
  entries: UiTimelineEntry[],
): string[] {
  const lines: string[] = [];

  lines.push(`  ${BOLD}${title}${RESET}`);
  lines.push('');

  if (entries.length === 0) {
    lines.push(`  ${DIM}No UI sub-steps recorded for this step.${RESET}`);
    return lines;
  }

  // Stats header
  const ok = entries.filter((e) => e.status === 'success').length;
  const failed = entries.filter((e) => e.status === 'failed').length;
  const inFlight = entries.filter((e) => e.status === 'in-progress').length;
  const statsParts: string[] = [`${GREEN}${ok} passed${RESET}`];
  if (failed > 0) {
    statsParts.push(`${RED}${failed} failed${RESET}`);
  }
  if (inFlight > 0) {
    statsParts.push(`${YELLOW}${inFlight} in-progress${RESET}`);
  }
  lines.push(`  ${statsParts.join('  ')}`);
  lines.push('');

  // Step root row — sub-steps and their downstream calls nest under this.
  // When the step author didn't name the step we still print the label so
  // the row clearly identifies which step this tree belongs to.
  const nameSuffix = root.stepName ? `: ${root.stepName}` : '';
  lines.push(`${BOLD}${root.stepLabel}${nameSuffix}${RESET}`);

  for (const entry of entries) {
    lines.push(...formatSubStep(entry));
  }

  return lines;
}

function formatSubStep(entry: UiTimelineEntry): string[] {
  const lines: string[] = [];

  const icon = statusIcon(entry.status);
  const actionLabel = padEnd(entry.action, 7);
  const target = entry.selector ? ` ${entry.selector}` : '';
  const duration = formatDuration(entry.durationMs);
  const error =
    entry.status === 'failed' && entry.error
      ? `   ${RED}${entry.error}${RESET}`
      : '';

  lines.push(
    `  ${icon} ${actionLabel}${target}   ${DIM}${duration}${RESET}${error}`,
  );

  // Render the (possibly nested) child forest. Indent grows by 5 spaces per
  // depth — matches the visual budget of "├─ " / "└─ " plus a leading space.
  appendChildren(lines, entry.children, '       ');

  return lines;
}

/**
 * Renders a step's HTTP/DB call forest under a step root, with the same
 * origin/target-aware indentation that UI timelines use. For non-UI steps
 * (httpRequest, dbQuery, etc.) where there are no UI sub-step rows.
 */
export function formatStepCallTree(
  title: string,
  root: TimelineRoot,
  calls: UiTimelineChild[],
): string[] {
  const lines: string[] = [];

  lines.push(`  ${BOLD}${title}${RESET}`);
  lines.push('');

  const nameSuffix = root.stepName ? `: ${root.stepName}` : '';
  lines.push(`${BOLD}${root.stepLabel}${nameSuffix}${RESET}`);

  if (calls.length === 0) {
    lines.push(
      `  ${DIM}No HTTP or DB activity recorded for this step.${RESET}`,
    );
    return lines;
  }

  appendChildren(lines, calls, '  ');
  return lines;
}

function appendChildren(
  lines: string[],
  children: UiTimelineChild[],
  indent: string,
): void {
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const isLast = i === children.length - 1;
    const branch = isLast ? '└─' : '├─';
    lines.push(`${indent}${DIM}${branch}${RESET} ${formatChild(child)}`);

    if (child.children.length > 0) {
      // Continuation column: vertical bar if more siblings follow, blank if
      // this was the last child. Five-space step keeps the tree readable.
      const continuation = isLast ? '     ' : `${DIM}│${RESET}    `;
      appendChildren(lines, child.children, indent + continuation);
    }
  }
}

function formatChild(child: UiTimelineChild): string {
  switch (child.kind) {
    case 'http': {
      const method = padEnd(child.method, 6);
      const status = child.statusCode ?? '---';
      const statusColor =
        typeof child.statusCode === 'number' && child.statusCode >= 400
          ? RED
          : GREEN;
      const targetPart = child.target ? ` ${child.target}` : '';
      const mocked = child.isMocked ? ` ${DIM}(mocked)${RESET}` : '';
      return `${CYAN}HTTP${RESET}  ${method}${targetPart} ${child.url}   ${statusColor}${status}${RESET}${mocked}`;
    }
    case 'db': {
      const query = child.query.replace(/\s+/g, ' ').trim();
      const marker = child.success ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
      const dur = formatDuration(child.durationMs);
      return `${CYAN}DB${RESET}    ${query} ${DIM}(${child.databaseName})${RESET}   ${marker}  ${DIM}${dur}${RESET}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Pure string helpers — easy to unit-test
// ---------------------------------------------------------------------------

function statusIcon(status: UiTimelineEntry['status']): string {
  switch (status) {
    case 'success':
      return `${GREEN}✓${RESET}`;
    case 'failed':
      return `${RED}✗${RESET}`;
    case 'in-progress':
      return `${YELLOW}⟳${RESET}`;
  }
}

function formatDuration(ms: number | null): string {
  if (ms === null) {
    return '-';
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function padEnd(s: string, n: number): string {
  if (s.length >= n) {
    return s;
  }
  return s + ' '.repeat(n - s.length);
}
