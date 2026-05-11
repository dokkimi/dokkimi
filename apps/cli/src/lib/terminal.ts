let altScreenActive = false;

process.on('exit', () => {
  if (altScreenActive) {
    process.stdout.write('\x1b[?1049l');
  }
});

export function waitForKey(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.once('data', (data: Buffer) => {
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      if (data.toString() === '\x03') {
        process.exit(0);
      }
      resolve();
    });
    process.stdout.write('\nPress any key to continue...');
  });
}

export function enterAltScreen(): void {
  altScreenActive = true;
  process.stdout.write('\x1b[?1049h');
  process.stdout.write('\x1b[2J\x1b[H');
}

export function exitAltScreen(): void {
  if (!altScreenActive) {
    return;
  }
  altScreenActive = false;
  process.stdout.write('\x1b[?1049l');
}

/** Move cursor up and erase the visual lines occupied by `block`. */
export function clearLines(block: string): void {
  if (!block || !process.stdout.isTTY) {
    return;
  }
  const termWidth = process.stdout.columns ?? 80;
  const lines = block.split('\n');
  let visualLines = 0;
  for (const line of lines) {
    const visible = line.replace(/\x1b\[[0-9;]*m/g, '').length;
    visualLines += Math.max(1, Math.ceil(visible / termWidth));
  }
  for (let i = 0; i < visualLines; i++) {
    process.stdout.write('\x1b[1A\x1b[2K');
  }
}

export function scrollableView(
  lines: string[],
  index: number,
  total: number,
): Promise<'back' | 'prev' | 'next'> {
  if (!process.stdin.isTTY) {
    return Promise.resolve('back');
  }

  return new Promise((resolve) => {
    let offset = 0;

    function render() {
      const termHeight = process.stdout.rows ?? 24;
      const viewHeight = termHeight - 2;
      const maxOffset = Math.max(0, lines.length - viewHeight);
      offset = Math.min(offset, maxOffset);

      // Build the entire frame into a single buffer to avoid flicker
      const buf: string[] = ['\x1b[H'];

      const visible = lines.slice(offset, offset + viewHeight);
      for (const line of visible) {
        buf.push(`\x1b[K${line}\n`);
      }
      const blank = viewHeight - visible.length;
      for (let i = 0; i < blank; i++) {
        buf.push('\x1b[K\n');
      }

      const position = total > 1 ? `${index + 1}/${total}` : '';
      const pct =
        lines.length <= viewHeight
          ? ''
          : `  ${Math.round(((offset + viewHeight) / lines.length) * 100)}%`;
      const nav = [
        index > 0 ? '\u2190 prev' : '',
        index < total - 1 ? '\u2192 next' : '',
      ]
        .filter(Boolean)
        .join('   ');
      const parts = [position, '\u2191\u2193 scroll', nav, 'ESC/q back'].filter(
        Boolean,
      );
      const hint = `\x1b[90m${parts.join('   ')}${pct}\x1b[0m`;
      buf.push(`\n\x1b[K${hint}`);

      process.stdout.write(buf.join(''));
    }

    function cleanup() {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeAllListeners('data');
      process.stdout.write('\x1b[2J\x1b[H');
    }

    render();
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (key: string) => {
      const termHeight = process.stdout.rows ?? 24;
      const viewHeight = termHeight - 2;
      const maxOffset = Math.max(0, lines.length - viewHeight);

      const scrollStep = 3;
      if (key === '\x1b[A' || key === '\x1bOA') {
        if (offset > 0) {
          offset = Math.max(0, offset - scrollStep);
          render();
        }
      } else if (key === '\x1b[B' || key === '\x1bOB') {
        if (offset < maxOffset) {
          offset = Math.min(maxOffset, offset + scrollStep);
          render();
        }
      } else if (key === '\x1b[5~') {
        if (offset > 0) {
          offset = Math.max(0, offset - viewHeight);
          render();
        }
      } else if (key === '\x1b[6~') {
        if (offset < maxOffset) {
          offset = Math.min(maxOffset, offset + viewHeight);
          render();
        }
      } else if (key === '\x1b[D' || key === '\x1bOD') {
        cleanup();
        resolve(index > 0 ? 'prev' : 'back');
      } else if (key === '\x1b[C' || key === '\x1bOC') {
        cleanup();
        resolve(index < total - 1 ? 'next' : 'back');
      } else if (key === '\x1b' || key === 'q') {
        cleanup();
        resolve('back');
      } else if (key === '\x03') {
        cleanup();
        process.exit(0);
      }
    });
  });
}
