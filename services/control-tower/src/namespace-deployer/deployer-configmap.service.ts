import { Injectable, Logger } from '@nestjs/common';
import { KubernetesResourceService } from '../namespace-lifecycle/kubernetes/kubernetes-resource.service';
import {
  ConfigMapBuilderService,
  MockEndpoint,
} from '../namespace-lifecycle/builders/configmap-builder.service';
import { ItemDefinitionLike } from '../namespace-lifecycle/builders/deployment-builder.types';
import { sanitizeK8sName } from '../utils/k8s.utils';
import { ExtractRule, TestStep } from '@dokkimi/config';
import { DeploymentContext } from './deployment-context.types';
import { hasUiSteps } from './ui-step-detection';

@Injectable()
export class DeployerConfigMapService {
  private readonly logger = new Logger(DeployerConfigMapService.name);

  constructor(
    private readonly k8sResource: KubernetesResourceService,
    private readonly configMapBuilder: ConfigMapBuilderService,
  ) {}

  async buildAndApply(ctx: DeploymentContext): Promise<void> {
    const items = ctx.definition.items;

    // Map items to ItemDefinitionLike[] for the configmap builder.
    // Cast needed: DefinitionItem.initFiles carries Buffer content,
    // while ItemDefinitionLike.initFiles expects {dbType, order}.
    // The configmap builder doesn't read initFiles, so the cast is safe.
    const itemsWithK8sName = items.map((item) => ({
      ...item,
      k8sName: sanitizeK8sName(item.name),
      id: ctx.instanceItemIds.get(item.name),
    })) as ItemDefinitionLike[];

    // Extract and format mock items
    const formattedMocks: MockEndpoint[] = items
      .filter((item) => item.type === 'MOCK')
      .map((mock) => {
        let responseBody: string | undefined;
        if (
          mock.mockResponseBody !== null &&
          mock.mockResponseBody !== undefined
        ) {
          responseBody =
            typeof mock.mockResponseBody === 'string'
              ? mock.mockResponseBody
              : JSON.stringify(mock.mockResponseBody);
        }

        let responseHeaders: string | undefined;
        if (
          mock.mockResponseHeaders !== null &&
          mock.mockResponseHeaders !== undefined
        ) {
          responseHeaders =
            typeof mock.mockResponseHeaders === 'string'
              ? mock.mockResponseHeaders
              : JSON.stringify(mock.mockResponseHeaders);
        }

        return {
          method: mock.mockMethod || '*',
          origin: mock.mockOrigin || '',
          target: mock.mockTarget || '*',
          path: mock.mockPath || '*',
          requestBodyContains: mock.mockRequestBodyContains ?? undefined,
          requestBodyMatches: mock.mockRequestBodyMatches ?? undefined,
          delayMS: mock.mockDelayMs ?? undefined,
          responseStatus: mock.mockResponseStatus ?? undefined,
          responseHeaders,
          responseBody,
        };
      });

    // Build test config if tests exist
    let testConfig:
      | {
          testRunId: string;
          timeoutSeconds: number;
          executionMode: string;
          tests: Record<string, unknown>[];
          variables?: Record<string, string>;
        }
      | undefined;
    let expectedNamespaceItemIds: string[] | undefined;

    if (ctx.definition.tests?.length) {
      const strippedTests = ctx.definition.tests.map((test) => ({
        ...test,
        steps: this.stripAssertionsFromSteps(test.steps),
      }));

      const executionMode = 'auto';

      testConfig = {
        testRunId: ctx.instanceId,
        timeoutSeconds: ctx.definition.config?.timeoutSeconds || 300,
        executionMode,
        tests: strippedTests,
        variables: ctx.definition.variables,
      };

      // Expected namespace item IDs: non-mock items only (mocks have no pods/sidecars)
      expectedNamespaceItemIds = items
        .filter((item) => item.type !== 'MOCK')
        .map((item) => ctx.instanceItemIds.get(item.name))
        .filter((id): id is string => id !== undefined);

      // Chromium reports health by name (no instanceItemId), so add it by
      // name to match the fallback in test-agent's handleHealthStatus.
      if (hasUiSteps(ctx.definition)) {
        expectedNamespaceItemIds.push('chromium');
      }
    }

    const configMap = this.configMapBuilder.buildInterceptorConfigMap(
      ctx.k8sNamespaceName,
      itemsWithK8sName,
      formattedMocks,
      ctx.instanceId,
      testConfig,
      expectedNamespaceItemIds,
    );

    await this.k8sResource.createOrUpdateConfigMap(
      ctx.k8sNamespaceName,
      configMap,
    );

    this.logger.log(
      `Created ConfigMap for instance ${ctx.instanceId} with ${items.length} items and ${formattedMocks.length} mocks`,
    );
  }

  /**
   * Strips assertions from test steps and merges per-assertion extract rules
   * into a single step-level extract.
   */
  private stripAssertionsFromSteps(
    steps: TestStep[],
  ): Record<string, unknown>[] {
    return steps.map((step) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { assertions, ...executionOnly } = step;

      // Merge per-assertion-block extract rules into the step-level extract
      // so test-agent can perform variable extraction at runtime.
      const mergedExtract: Record<string, ExtractRule> = {
        ...(step.extract as Record<string, ExtractRule>),
      };
      if (step.assertions) {
        for (const assertion of step.assertions) {
          if ('extract' in assertion && assertion.extract) {
            Object.assign(mergedExtract, assertion.extract);
          }
        }
      }

      return {
        ...executionOnly,
        ...(Object.keys(mergedExtract).length > 0
          ? { extract: mergedExtract }
          : {}),
      };
    });
  }
}
