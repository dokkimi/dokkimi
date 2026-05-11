export interface MenuItem<T = unknown> {
  label: string;
  value: T;
  disabled?: boolean; // shown but not selectable; cursor skips over
}

export interface SelectMenuOptions {
  initialIndex?: number;
  /** When true, left-arrow acts as back (returns null). Disabled for root menus. */
  leftArrowBack?: boolean;
  /** Extra hint text appended to the bottom navigation line. */
  extraHint?: string;
  /** Handle custom keys. Return a string action to resolve the menu, or null to ignore. */
  onKey?: (key: string) => string | null;
}

export interface SelectMenuResult<T> {
  value: T;
  index: number;
  /** Set when the menu was resolved via a custom onKey action. */
  action?: string;
}

/**
 * Interactive arrow-key selection menu using in-place redraw.
 */
export function selectMenu<T>(
  items: MenuItem<T>[],
  title: string,
  options: SelectMenuOptions = {},
): Promise<SelectMenuResult<T> | null> {
  const {
    initialIndex = 0,
    leftArrowBack = false,
    extraHint,
    onKey: onCustomKey,
  } = options;
  if (!process.stdin.isTTY || items.length === 0) {
    return Promise.resolve(null);
  }

  // Clamp initialIndex to a selectable item
  const firstSelectable = items.findIndex((i) => !i.disabled);
  if (firstSelectable === -1) {
    return Promise.resolve(null);
  }

  return new Promise<SelectMenuResult<T> | null>((resolve) => {
    let cursor = clampToSelectable(items, initialIndex);
    let scrollOffset = 0;

    function render() {
      const termHeight = process.stdout.rows || 24;
      // Reserve lines for: title, blank after title, more-above, more-below, hints
      const chromeLines = 6;
      const maxVisible = Math.max(1, termHeight - chromeLines);
      const needsScroll = items.length > maxVisible;

      // Adjust scrollOffset to keep cursor visible
      if (cursor < scrollOffset) {
        scrollOffset = cursor;
      } else if (cursor >= scrollOffset + maxVisible) {
        scrollOffset = cursor - maxVisible + 1;
      }
      // Clamp scrollOffset
      const maxOffset = Math.max(0, items.length - maxVisible);
      scrollOffset = Math.min(scrollOffset, maxOffset);
      scrollOffset = Math.max(0, scrollOffset);

      const visibleEnd = Math.min(items.length, scrollOffset + maxVisible);

      const hasMoreAbove = needsScroll && scrollOffset > 0;
      const hasMoreBelow = needsScroll && visibleEnd < items.length;

      process.stdout.write('\x1b[H');
      process.stdout.write(`\x1b[K\x1b[1m${title}\x1b[0m\n`);
      process.stdout.write(
        hasMoreAbove
          ? `\x1b[K\x1b[90m  ▲ ${scrollOffset} more above\x1b[0m\n`
          : '\x1b[K\n',
      );

      for (let i = scrollOffset; i < visibleEnd; i++) {
        const item = items[i];
        if (item.disabled) {
          process.stdout.write(`\x1b[K\x1b[90m${item.label}\x1b[0m\n`);
        } else {
          const active = i === cursor;
          const prefix = active ? '\x1b[36m▶\x1b[0m ' : '  ';
          const text = active
            ? `\x1b[1m\x1b[36m${item.label}\x1b[0m`
            : item.label;
          process.stdout.write(`\x1b[K${prefix}${text}\n`);
        }
      }

      const remaining = items.length - visibleEnd;
      process.stdout.write(
        hasMoreBelow
          ? `\x1b[K\x1b[90m  ▼ ${remaining} more below\x1b[0m\n`
          : '\x1b[K\n',
      );
      const backHint = leftArrowBack ? '←/ESC/q back' : 'ESC/q back';
      const extra = extraHint ? `   ${extraHint}` : '';
      process.stdout.write(
        `\x1b[K\x1b[90m↑↓ navigate   →/Enter select   ${backHint}${extra}\x1b[0m\n`,
      );
      // Clear any leftover lines below
      process.stdout.write('\x1b[J');
    }

    function cleanup() {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeAllListeners('data');
    }

    render();
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (key: string) => {
      if (key === '\x1b[A' || key === '\x1bOA') {
        cursor = clampToSelectable(items, cursor - 1, -1);
        render();
      } else if (key === '\x1b[B' || key === '\x1bOB') {
        cursor = clampToSelectable(items, cursor + 1, 1);
        render();
      } else if (
        key === '\r' ||
        key === '\n' ||
        key === '\x1b[C' ||
        key === '\x1bOC'
      ) {
        cleanup();
        resolve({ value: items[cursor].value, index: cursor });
      } else if (leftArrowBack && (key === '\x1b[D' || key === '\x1bOD')) {
        cleanup();
        resolve(null);
      } else if (key === '\x1b' || key === 'q') {
        cleanup();
        resolve(null);
      } else if (key === '\x03') {
        cleanup();
        process.exit(0);
      } else if (onCustomKey) {
        const action = onCustomKey(key);
        if (action) {
          cleanup();
          resolve({ value: items[cursor].value, index: cursor, action });
        }
      }
    });
  });
}

/**
 * Find the nearest selectable (non-disabled) item from `index` in direction `dir`.
 * dir: 1 = forward, -1 = backward, 0 = nearest from current position.
 */
function clampToSelectable<T>(
  items: MenuItem<T>[],
  index: number,
  dir: 1 | -1 | 0 = 0,
): number {
  const n = items.length;
  // Wrap index into range
  index = ((index % n) + n) % n;

  // Try forward/backward from the given index
  for (let i = 0; i < n; i++) {
    const step = dir === -1 ? -i : i;
    const idx = (((index + step) % n) + n) % n;
    if (!items[idx].disabled) {
      return idx;
    }
  }
  return index;
}
