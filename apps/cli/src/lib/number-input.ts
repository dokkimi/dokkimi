export interface NumberInputOptions {
  min?: number;
  max?: number;
}

export function numberInput(
  label: string,
  current: number,
  options: NumberInputOptions = {},
): Promise<number | null> {
  const { min = 1, max = 999 } = options;

  if (!process.stdin.isTTY) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let value = String(current);

    function render() {
      const hint = `\x1b[90m${min}–${max}   Enter confirm   ESC cancel\x1b[0m`;
      process.stdout.write('\x1b[H\x1b[2J');
      process.stdout.write(`\x1b[1m${label}\x1b[0m\n\n`);
      process.stdout.write(`  > ${value}\x1b[K\n\n`);
      process.stdout.write(hint);
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
      if (key === '\x1b') {
        cleanup();
        resolve(null);
      } else if (key === '\x03') {
        cleanup();
        process.exit(0);
      } else if (key === '\r' || key === '\n') {
        const num = parseInt(value, 10);
        cleanup();
        if (isNaN(num) || num < min || num > max) {
          resolve(null);
        } else {
          resolve(num);
        }
      } else if (key === '\x7f' || key === '\b') {
        value = value.slice(0, -1);
        render();
      } else if (key >= '0' && key <= '9') {
        value += key;
        render();
      }
    });
  });
}
