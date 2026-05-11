import * as path from 'path';
import type { DokkimiConfig } from '@dokkimi/definition-resolver';

let cached: string | null = null;

export function getCliVersion(): string {
  if (cached) {
    return cached;
  }

  try {
    // __dirname = apps/cli/dist/lib → root is 4 levels up (both monorepo and installed)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require(
      path.resolve(__dirname, '..', '..', '..', '..', 'package.json'),
    );
    cached = pkg.version || 'unknown';
  } catch {
    cached = 'unknown';
  }

  return cached!;
}

/**
 * Compares the config's dokkimi version against the CLI version.
 * Prints a yellow warning if the config targets a newer version.
 */
export function warnIfVersionMismatch(config: DokkimiConfig): void {
  if (!config.dokkimi) {
    return;
  }

  const cli = getCliVersion();
  if (cli === 'unknown') {
    return;
  }

  const configParts = config.dokkimi.split('.').map(Number);
  const cliParts = cli.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const c = configParts[i] ?? 0;
    const v = cliParts[i] ?? 0;
    if (c > v) {
      console.log(
        `\x1b[33mWarning: config.yaml targets Dokkimi ${config.dokkimi} but you have ${cli}. Run "brew upgrade dokkimi" to update.\x1b[0m`,
      );
      return;
    }
    if (c < v) {
      return;
    }
  }
}
