import { fetchJson } from '../lib/cli-utils';
import { selectMenu, MenuItem } from '../lib/menu';
import { waitForKey } from '../lib/terminal';
import { formatLogLine, instanceStatusBadge } from '../lib/formatting';
import { stripIds, formatHttpLog, openInEditor } from '../lib/editor';
import {
  InstanceMenuAction,
  buildInstanceMenuItems,
} from '../lib/inspect-helpers';
import type {
  InstanceSummary,
  DefinitionSnapshot,
  InstanceItemStatus,
  HttpLogsResponse,
} from '../lib/inspect-types';
import { showItemDetailFlow } from '../lib/inspect-item-flow';

export async function showHttpLogsFlow(
  ctUrl: string,
  instance: InstanceSummary,
  definition: DefinitionSnapshot | null,
  instanceItems: InstanceItemStatus[],
): Promise<'back' | 'exit'> {
  const logsRes = await fetchJson<HttpLogsResponse>(
    `${ctUrl}/logs/http/instance/${instance.id}?limit=500`,
  );
  if (!logsRes || logsRes.logs.length === 0) {
    console.log(`No traffic logs found for "${instance.name}".`);
    await waitForKey();
    return 'back';
  }
  const logs = [...logsRes.logs].reverse();

  const hasAnyOrigin = logs.some((log) => log.origin);
  const trafficItems: MenuItem<InstanceMenuAction>[] = logs.map((log) => ({
    label: formatLogLine(log, hasAnyOrigin),
    value: { kind: 'traffic-log' as const, log },
  }));

  let lastIndex = 0;
  while (true) {
    process.stdout.write('\x1b[2J\x1b[H');

    const allMenuItems = buildInstanceMenuItems(
      definition,
      instance,
      instanceItems,
      trafficItems,
      'Traffic',
    );

    const picked = await selectMenu(
      allMenuItems,
      `${instance.name}  ${instanceStatusBadge(instance)}`,
      { leftArrowBack: true, initialIndex: lastIndex },
    );
    if (!picked) {
      return 'back';
    }
    lastIndex = picked.index;

    switch (picked.value.kind) {
      case 'raw': {
        openInEditor(stripIds(definition), `${instance.name}-definition.json`);
        break;
      }
      case 'item': {
        const nav = await showItemDetailFlow(
          ctUrl,
          instance,
          picked.value.item,
          instanceItems,
        );
        if (nav === 'exit') {
          return 'exit';
        }
        break;
      }
      case 'traffic-log': {
        openInEditor(
          formatHttpLog(picked.value.log),
          `${instance.name}-http-log-${logs.indexOf(picked.value.log) + 1}.json`,
        );
        break;
      }
    }
  }
}
