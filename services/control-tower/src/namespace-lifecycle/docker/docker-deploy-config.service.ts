import { Injectable, Logger } from '@nestjs/common';
import { getConfig } from '@dokkimi/config';
import {
  DockerConfigService,
  InstanceConfigPaths,
} from './docker-config.service';
import { sanitizeContainerName } from '../../utils/name.utils';
import { DeploymentContext } from '../deployment-context.types';
import { hasUiSteps } from '../ui-step-detection';

@Injectable()
export class DockerDeployConfigService {
  private readonly logger = new Logger(DockerDeployConfigService.name);

  constructor(private readonly dockerConfig: DockerConfigService) {}

  async writeConfig(
    ctx: DeploymentContext,
    configPaths: InstanceConfigPaths,
  ): Promise<void> {
    const items = ctx.definition.items;
    const itemsWithContainerName = items.map((item) => ({
      ...item,
      containerName: sanitizeContainerName(item.name),
      id: ctx.instanceItemIds.get(item.name),
    }));

    const mocks = items
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
          responseHeaders = JSON.stringify(mock.mockResponseHeaders);
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

    let testConfig:
      | {
          testRunId: string;
          timeoutSeconds: number;
          executionMode: string;
          tests: any[];
          variables?: Record<string, unknown>;
        }
      | undefined;
    let expectedNamespaceItemIds: string[] | undefined;

    if (ctx.definition.tests?.length) {
      testConfig = {
        testRunId: ctx.instanceId,
        timeoutSeconds: ctx.definition.config?.timeoutSeconds || 300,
        executionMode: 'auto',
        tests: ctx.definition.tests,
        variables: ctx.definition.variables,
      };

      expectedNamespaceItemIds = items
        .filter((item) => item.type !== 'MOCK')
        .map((item) => ctx.instanceItemIds.get(item.name))
        .filter((id): id is string => id !== undefined);

      const chromiumItemId = ctx.instanceItemIds.get('chromium');
      if (hasUiSteps(ctx.definition) && chromiumItemId) {
        expectedNamespaceItemIds.push(chromiumItemId);
      }
    }

    this.dockerConfig.writeInterceptorConfig(
      configPaths,
      itemsWithContainerName as any,
      mocks,
      ctx.instanceId,
      testConfig,
      expectedNamespaceItemIds,
    );
  }

  buildDnsmasqConfig(
    dockerDnsIP: string,
    databaseNames: string[],
    interceptorIP: string,
  ): string {
    const config = getConfig();
    const dnsNameserver = config.network.dns.nameserver;
    const lines: string[] = [];

    lines.push(`listen-address=${dnsNameserver}`);

    for (const dbName of databaseNames) {
      lines.push(`server=/${dbName}/${dockerDnsIP}`);
    }

    lines.push(`server=/host.docker.internal/${dockerDnsIP}`);
    lines.push(`address=/#/${interceptorIP}`);
    lines.push('cache-size=1000');
    lines.push('no-hosts');
    lines.push('no-resolv');
    lines.push('log-queries');
    lines.push('log-facility=-');

    return lines.join('\n');
  }
}
