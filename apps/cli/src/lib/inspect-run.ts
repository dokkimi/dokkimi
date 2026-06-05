import { fetchJson } from './cli-utils';
import { selectMenu } from './menu';
import { enterAltScreen, exitAltScreen } from './terminal';
import { formatInstanceLabel } from './formatting';
import { showTestStepsFlow } from './inspect-test-flow';
import { showHttpLogsFlow } from './inspect-http-flow';
import type {
  InstanceSummary,
  DefinitionSnapshot,
  InstanceDetail,
} from './inspect-types';

/**
 * Core inspect loop — displays instance picker and drills into test/traffic results.
 * Used by both `dokkimi inspect` and the post-run inspect prompt.
 */
export async function inspectRun(
  ctUrl: string,
  runId: string,
  instances: InstanceSummary[],
  storageDir: string,
  options?: { manageAltScreen?: boolean },
): Promise<void> {
  const manageAltScreen = options?.manageAltScreen ?? true;
  if (manageAltScreen) {
    enterAltScreen();
  }

  try {
    while (true) {
      const picked = await selectMenu(
        instances.map((i) => ({ label: formatInstanceLabel(i), value: i })),
        'Select a definition to inspect:',
        { leftArrowBack: !manageAltScreen },
      );
      if (!picked) {
        break;
      }
      const instance = picked.value;

      process.stdout.write('\x1b[2J\x1b[H');

      const [definition, instanceDetail] = await Promise.all([
        fetchJson<DefinitionSnapshot>(
          `${ctUrl}/runs/${runId}/instances/${instance.id}/definition`,
        ),
        fetchJson<InstanceDetail>(
          `${ctUrl}/namespaces/instances/${instance.id}`,
        ),
      ]);
      const tests = definition?.tests;
      const instanceItems = instanceDetail?.items ?? [];

      let nav: 'back' | 'exit';
      if (tests && tests.length > 0) {
        nav = await showTestStepsFlow(
          ctUrl,
          instance,
          definition,
          instanceItems,
          tests,
          storageDir,
        );
      } else {
        nav = await showHttpLogsFlow(
          ctUrl,
          instance,
          definition,
          instanceItems,
        );
      }
      if (nav === 'exit') {
        break;
      }
      process.stdout.write('\x1b[2J\x1b[H');
    }
  } finally {
    if (manageAltScreen) {
      exitAltScreen();
    }
  }
}
