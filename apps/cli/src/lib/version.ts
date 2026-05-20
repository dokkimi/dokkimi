import { DOKKIMI_VERSION } from '@dokkimi/config';
import type { DokkimiConfig } from '@dokkimi/definition-resolver';

export function warnIfVersionMismatch(config: DokkimiConfig): void {
  if (!config.dokkimi) {
    return;
  }

  const configParts = config.dokkimi.split('.').map(Number);
  const cliParts = DOKKIMI_VERSION.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const c = configParts[i] ?? 0;
    const v = cliParts[i] ?? 0;
    if (c > v) {
      console.log(
        `\x1b[33mWarning: config.yaml targets Dokkimi ${config.dokkimi} but you have ${DOKKIMI_VERSION}. Run "brew upgrade dokkimi" to update.\x1b[0m`,
      );
      return;
    }
    if (c < v) {
      return;
    }
  }
}
