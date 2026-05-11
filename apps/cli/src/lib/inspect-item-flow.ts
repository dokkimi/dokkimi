import { fetchJson } from '../lib/cli-utils';
import { selectMenu, MenuItem } from '../lib/menu';
import {
  stripIds,
  formatConsoleLogs,
  formatPodLogs,
  openInEditor,
} from '../lib/editor';
import type {
  InstanceSummary,
  DefinitionSnapshotItem,
  InstanceItemStatus,
  ConsoleLogsResponse,
  TestExecutionLogsResponse,
} from '../lib/inspect-types';

type ItemDetailAction =
  | { kind: 'raw-item' }
  | { kind: 'console-logs' }
  | { kind: 'pod-logs' };

export async function showItemDetailFlow(
  ctUrl: string,
  instance: InstanceSummary,
  item: DefinitionSnapshotItem,
  instanceItems: InstanceItemStatus[],
): Promise<'back' | 'exit'> {
  const ii = instanceItems.find((i) => i.itemDefinitionName === item.name);

  let lastIndex = 0;
  while (true) {
    process.stdout.write('\x1b[2J\x1b[H');

    const menuItems: MenuItem<ItemDetailAction>[] = [
      { label: 'Raw Definition', value: { kind: 'raw-item' } },
    ];

    if (ii) {
      menuItems.push({
        label: 'Console Logs',
        value: { kind: 'console-logs' },
      });
    }

    if (instance.errorMessage) {
      menuItems.push({
        label: 'Pod Logs',
        value: { kind: 'pod-logs' },
      });
    }

    const picked = await selectMenu(
      menuItems,
      `${instance.name} \u203a ${item.name}`,
      { leftArrowBack: true, initialIndex: lastIndex },
    );
    if (!picked) {
      return 'back';
    }
    lastIndex = picked.index;

    switch (picked.value.kind) {
      case 'raw-item': {
        openInEditor(stripIds(item), `${instance.name}-${item.name}.json`);
        break;
      }
      case 'console-logs': {
        const res = await fetchJson<ConsoleLogsResponse>(
          `${ctUrl}/logs/console/instance/${instance.id}?instanceItemId=${ii!.id}&limit=1000`,
        );
        const logs = (res?.logs ?? []).reverse();
        openInEditor(
          formatConsoleLogs(logs),
          `${instance.name}-${item.name}-console.log`,
        );
        break;
      }
      case 'pod-logs': {
        const res = await fetchJson<TestExecutionLogsResponse>(
          `${ctUrl}/logs/test-execution/instance/${instance.id}?limit=1000`,
        );
        const podLogs = (res?.logs ?? []).filter(
          (l) =>
            l.eventType === 'POD_LOGS' &&
            l.message.startsWith(`[item:${item.name}]`),
        );
        openInEditor(
          formatPodLogs(podLogs, item.name),
          `${instance.name}-${item.name}-pod-logs.log`,
        );
        break;
      }
    }
  }
}
