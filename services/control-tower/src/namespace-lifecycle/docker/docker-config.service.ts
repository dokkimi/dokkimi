import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getConfig } from '@dokkimi/config';
import {
  ConfigMapBuilderService,
  MockEndpoint,
  ItemDefinitionLike,
} from '../builders/configmap-builder.service';

export interface InstanceConfigPaths {
  configDir: string;
  configJsonPath: string;
  dnsmasqDir: string;
  resolvConfPath: string;
}

@Injectable()
export class DockerConfigService {
  private readonly logger = new Logger(DockerConfigService.name);

  constructor(private readonly configMapBuilder: ConfigMapBuilderService) {}

  createConfigDir(instanceId: string): InstanceConfigPaths {
    const configDir = path.join(os.tmpdir(), `dokkimi-${instanceId}`);
    const dnsmasqDir = path.join(configDir, 'dnsmasq');

    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(dnsmasqDir, { recursive: true });

    const resolvConfPath = path.join(configDir, 'resolv.conf');
    const dnsNameserver = getConfig().network.dns.nameserver;
    fs.writeFileSync(resolvConfPath, `nameserver ${dnsNameserver}\n`);

    return {
      configDir,
      configJsonPath: path.join(configDir, 'config.json'),
      dnsmasqDir,
      resolvConfPath,
    };
  }

  writeInterceptorConfig(
    configPaths: InstanceConfigPaths,
    items: ItemDefinitionLike[],
    mocks: MockEndpoint[],
    instanceId: string,
    testConfig?: {
      testRunId: string;
      timeoutSeconds: number;
      executionMode: string;
      tests: Record<string, unknown>[];
      variables?: Record<string, unknown>;
    },
    expectedItemStages?: string[][],
  ): void {
    const configMap = this.configMapBuilder.buildInterceptorConfigMap(
      `dokkimi-run-${instanceId}`,
      items,
      mocks,
      instanceId,
      testConfig,
      expectedItemStages,
    );

    const configData = configMap.data || {};
    fs.writeFileSync(
      configPaths.configJsonPath,
      JSON.stringify(configData, null, 2),
    );

    this.logger.log(
      `Wrote interceptor config to ${configPaths.configJsonPath}`,
    );
  }

  writeDnsmasqConfig(
    configPaths: InstanceConfigPaths,
    serviceName: string,
    config: string,
  ): string {
    const confPath = path.join(configPaths.dnsmasqDir, `${serviceName}.conf`);
    fs.writeFileSync(confPath, config);
    return confPath;
  }

  cleanupConfigDir(instanceId: string): void {
    const configDir = path.join(os.tmpdir(), `dokkimi-${instanceId}`);
    try {
      fs.rmSync(configDir, { recursive: true, force: true });
      this.logger.log(`Cleaned up config dir: ${configDir}`);
    } catch (error) {
      this.logger.warn(`Failed to clean up config dir ${configDir}: ${error}`);
    }
  }
}
