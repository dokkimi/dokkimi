import * as path from 'path';
import { fetchJson } from '../lib/cli-utils';
import { selectMenu, MenuItem } from '../lib/menu';
import {
  fitText,
  statusBadge,
  instanceStatusBadge,
  describeAction,
} from '../lib/formatting';
import {
  stripIds,
  openInEditor,
  openFile,
  formatTestExecutionLogs,
} from '../lib/editor';
import {
  InstanceMenuAction,
  buildInstanceMenuItems,
  deriveGroupStatuses,
  deriveStepAssertionStatuses,
  rewriteErrorMessage,
} from '../lib/inspect-helpers';
import type {
  InstanceSummary,
  DefinitionSnapshot,
  InstanceItemStatus,
  HttpLog,
  HttpLogsResponse,
  TestExecutionLog,
  TestExecutionLogsResponse,
  AssertionResult,
  ArtifactRow,
  ArtifactsResponse,
  FlatStepGroup,
  TestSuite,
} from '../lib/inspect-types';
import { showStepDetail } from '../lib/inspect-step-detail';
import { showItemDetailFlow } from '../lib/inspect-item-flow';

export async function showTestStepsFlow(
  ctUrl: string,
  instance: InstanceSummary,
  definition: DefinitionSnapshot | null,
  instanceItems: InstanceItemStatus[],
  tests: TestSuite[],
  storageDir: string,
): Promise<'back' | 'exit'> {
  const flatGroups: FlatStepGroup[] = [];
  const suiteGroupRanges: {
    name: string;
    startIndex: number;
    endIndex: number;
  }[] = [];

  for (const test of tests) {
    if (!Array.isArray(test.steps)) {
      continue;
    }
    const startIndex = flatGroups.length;
    for (const step of test.steps) {
      if (!step || typeof step !== 'object') {
        continue;
      }
      flatGroups.push({
        globalIndex: flatGroups.length,
        testName: test.name ?? `Test ${suiteGroupRanges.length + 1}`,
        steps: [step],
      });
    }
    if (flatGroups.length > startIndex) {
      suiteGroupRanges.push({
        name: test.name ?? `Test ${suiteGroupRanges.length + 1}`,
        startIndex,
        endIndex: flatGroups.length - 1,
      });
    }
  }

  const [execRes, assertions, httpLogsRes, artifactsRes] = await Promise.all([
    fetchJson<TestExecutionLogsResponse>(
      `${ctUrl}/logs/test-execution/instance/${instance.id}`,
    ),
    fetchJson<AssertionResult[]>(
      `${ctUrl}/logs/assertion-results/instance/${instance.id}`,
    ),
    fetchJson<HttpLogsResponse>(
      `${ctUrl}/logs/http/instance/${instance.id}?limit=500`,
    ),
    fetchJson<ArtifactsResponse>(`${ctUrl}/artifacts/instance/${instance.id}`),
  ]);

  const execLogs = execRes?.logs ?? [];
  const assertionResults = assertions ?? [];
  const allHttpLogs = httpLogsRes?.logs ? [...httpLogsRes.logs].reverse() : [];
  const screenshots = (artifactsRes?.artifacts ?? []).filter(
    (a) => a.type === 'screenshot',
  );

  const groupStatus = deriveGroupStatuses(execLogs, flatGroups.length);
  const stepAssertionStatus = deriveStepAssertionStatuses(assertionResults);

  function getSuiteStatus(suite: {
    startIndex: number;
    endIndex: number;
  }): string {
    let hasRunning = false;
    let hasPending = false;
    let hasSkipped = false;
    let hasNotValidated = false;
    for (let gi = suite.startIndex; gi <= suite.endIndex; gi++) {
      const group = flatGroups[gi];
      for (let si = 0; si < group.steps.length; si++) {
        const sKey = `${gi}:${si}`;
        const status =
          stepAssertionStatus.get(sKey) ?? groupStatus.get(gi) ?? 'PENDING';
        if (status === 'FAILED') {
          return 'FAILED';
        }
        if (status === 'RUNNING') {
          hasRunning = true;
        }
        if (status === 'PENDING') {
          hasPending = true;
        }
        if (status === 'SKIPPED') {
          hasSkipped = true;
        }
        if (status === 'NOT_VALIDATED') {
          hasNotValidated = true;
        }
      }
    }
    if (hasRunning) {
      return 'RUNNING';
    }
    if (hasPending) {
      return 'PENDING';
    }
    if (hasNotValidated) {
      return 'NOT_VALIDATED';
    }
    if (hasSkipped) {
      return 'SKIPPED';
    }
    return 'PASSED';
  }

  let lastIndex = 0;
  while (true) {
    process.stdout.write('\x1b[2J\x1b[H');

    const termWidth = process.stdout.columns ?? 80;
    const nameWidth = Math.max(20, termWidth - 26);

    const suiteMenuItems: MenuItem<InstanceMenuAction>[] = suiteGroupRanges.map(
      (suite, i) => {
        const badge = statusBadge(getSuiteStatus(suite));
        return {
          label: `\x1b[35mStep ${i + 1}:\x1b[0m ${fitText(suite.name, nameWidth)} ${badge}`,
          value: { kind: 'suite' as const, suiteIndex: i },
        };
      },
    );

    // Rewrite error message to use test/step names instead of "step group N"
    const displayInstance = instance.errorMessage
      ? {
          ...instance,
          errorMessage: rewriteErrorMessage(instance.errorMessage, flatGroups),
        }
      : instance;

    const allMenuItems = buildInstanceMenuItems(
      definition,
      displayInstance,
      instanceItems,
      suiteMenuItems,
      'Tests',
      screenshots.length > 0,
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
      case 'test-logs': {
        openInEditor(
          formatTestExecutionLogs(execLogs),
          `${instance.name}-test-logs.log`,
        );
        break;
      }
      case 'screenshots': {
        const nav = await showScreenshotsFlow(
          instance,
          screenshots,
          storageDir,
        );
        if (nav === 'exit') {
          return 'exit';
        }
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
      case 'suite': {
        const nav = await showSubstepsFlow(
          ctUrl,
          instance,
          flatGroups,
          suiteGroupRanges[picked.value.suiteIndex],
          picked.value.suiteIndex,
          groupStatus,
          stepAssertionStatus,
          assertionResults,
          execLogs,
          allHttpLogs,
          definition,
          instanceItems,
          screenshots,
          storageDir,
        );
        if (nav === 'exit') {
          return 'exit';
        }
        break;
      }
    }
  }
}

async function showSubstepsFlow(
  ctUrl: string,
  instance: InstanceSummary,
  flatGroups: FlatStepGroup[],
  suite: { name: string; startIndex: number; endIndex: number },
  suiteNumber: number,
  groupStatus: Map<number, string>,
  stepAssertionStatus: Map<string, string>,
  assertionResults: AssertionResult[],
  execLogs: TestExecutionLog[],
  allHttpLogs: HttpLog[],
  definition: DefinitionSnapshot | null,
  instanceItems: InstanceItemStatus[],
  screenshots: ArtifactRow[],
  storageDir: string,
): Promise<'back' | 'exit'> {
  const termWidth = process.stdout.columns ?? 80;
  const nameWidth = Math.max(20, termWidth - 28);

  const substepItems: MenuItem<{
    stepIndex: number;
    subStepIndex: number;
    stepLabel: string;
  }>[] = [];
  let substepNum = 1;

  for (let gi = suite.startIndex; gi <= suite.endIndex; gi++) {
    const group = flatGroups[gi];
    for (let si = 0; si < group.steps.length; si++) {
      const step = group.steps[si];
      const sKey = `${gi}:${si}`;
      const status =
        stepAssertionStatus.get(sKey) ?? groupStatus.get(gi) ?? 'PENDING';
      const badge = statusBadge(status);
      const stepName = step.name ?? describeAction(step);
      const stepLabel = `Step ${suiteNumber + 1}.${substepNum}`;

      substepItems.push({
        label: `${stepLabel}: ${fitText(stepName, nameWidth)} ${badge}`,
        value: { stepIndex: gi, subStepIndex: si, stepLabel },
      });
      substepNum++;
    }
  }

  const errorBanner: MenuItem<{
    stepIndex: number;
    subStepIndex: number;
    stepLabel: string;
  }>[] = [];
  if (instance.errorMessage) {
    errorBanner.push({
      label: `\x1b[31m${instance.errorMessage}\x1b[0m`,
      value: null as never,
      disabled: true,
    });
    errorBanner.push({ label: '', value: null as never, disabled: true });
  }

  let lastIndex = 0;
  while (true) {
    process.stdout.write('\x1b[2J\x1b[H');
    const picked = await selectMenu(
      [...errorBanner, ...substepItems],
      `${instance.name} \u203a Step ${suiteNumber + 1}  ${instanceStatusBadge(instance)}`,
      { leftArrowBack: true, initialIndex: lastIndex },
    );
    if (!picked) {
      return 'back';
    }
    lastIndex = picked.index;

    const stepScreenshots = screenshots.filter(
      (a) => a.stepIndex === picked.value.stepIndex,
    );
    const nav = await showStepDetail(
      ctUrl,
      instance,
      flatGroups,
      picked.value.stepIndex,
      picked.value.subStepIndex,
      picked.value.stepLabel,
      assertionResults,
      execLogs,
      allHttpLogs,
      definition,
      instanceItems,
      stepScreenshots,
      storageDir,
    );
    if (nav === 'exit') {
      return 'exit';
    }
  }
}

async function showScreenshotsFlow(
  instance: InstanceSummary,
  screenshots: ArtifactRow[],
  storageDir: string,
): Promise<'back' | 'exit'> {
  let lastIndex = 0;
  while (true) {
    process.stdout.write('\x1b[2J\x1b[H');

    const menuItems: MenuItem<ArtifactRow>[] = screenshots.map((a) => ({
      label: a.name ?? `screenshot-${a.stepIndex}-${a.subStepIndex}`,
      value: a,
    }));

    const picked = await selectMenu(
      menuItems,
      `${instance.name} › Screenshots`,
      { leftArrowBack: true, initialIndex: lastIndex },
    );
    if (!picked) {
      return 'back';
    }
    lastIndex = picked.index;

    const absolutePath = path.isAbsolute(picked.value.uri)
      ? picked.value.uri
      : path.join(storageDir, picked.value.uri);
    openFile(absolutePath);
  }
}
