import { Injectable } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import {
  getConfig,
  buildDbProxyEnvVars,
  buildServiceUrl,
} from '@dokkimi/config';
import { DOKKIMI_IMAGES } from '../../constants/image-tags';
import {
  ItemDefinitionLike,
  FLUENT_BIT_RESOURCES,
} from './deployment-builder.types';
import { buildResources } from './deployment-builder.utils';

@Injectable()
export class DatabaseDeploymentBuilderService {
  buildDatabaseDeployment(
    item: ItemDefinitionLike,
    namespace: string,
    instanceId: string,
    instanceItemId: string,
    dbConfig: {
      image: string;
      environment: Record<string, string>;
      ports: number[];
      command?: string[];
      volumeMounts?: k8s.V1VolumeMount[];
      volumes?: k8s.V1Volume[];
    },
  ): k8s.V1Deployment {
    const deploymentName = item.k8sName;

    const initFileMountPath = this.getInitFileMountPath(item.database);

    const volumeMounts = [...(dbConfig.volumeMounts || [])];
    const volumes = [...(dbConfig.volumes || [])];

    const shouldMountInitFiles =
      (item.initFiles?.length && initFileMountPath) ||
      this.isMongoType(item.database);

    const initContainers: k8s.V1Container[] = [];

    if (shouldMountInitFiles && initFileMountPath) {
      volumeMounts.push({
        name: 'init-files',
        mountPath: initFileMountPath,
        readOnly: true,
      });

      volumes.push({
        name: 'init-files',
        emptyDir: {},
      });

      const ctUrl = buildServiceUrl(getConfig().services.controlTower, true);

      initContainers.push({
        name: 'fetch-init-files',
        image: DOKKIMI_IMAGES.initFetcher,
        imagePullPolicy: 'IfNotPresent',
        command: ['sh', '-c'],
        args: [
          `for i in 1 2 3 4 5; do wget -qO- "${ctUrl}/init-files/${instanceId}/${encodeURIComponent(item.name)}" | tar xf - -C /init-data && exit 0; sleep 2; done; exit 1`,
        ],
        volumeMounts: [{ name: 'init-files', mountPath: '/init-data' }],
      });
    }

    return {
      metadata: {
        name: deploymentName,
        namespace,
        labels: { app: deploymentName },
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: deploymentName } },
        template: {
          metadata: {
            labels: {
              app: deploymentName,
              'dokkimi.io/instance-id': instanceId,
            },
          },
          spec: {
            terminationGracePeriodSeconds: 3,
            ...(initContainers.length > 0 ? { initContainers } : {}),
            containers: [
              {
                name: deploymentName,
                image: dbConfig.image,
                ...(dbConfig.command ? { command: dbConfig.command } : {}),
                env: Object.entries(dbConfig.environment).map(
                  ([key, value]) => ({ name: key, value: String(value) }),
                ),
                ports: dbConfig.ports.map((port) => ({
                  containerPort: port,
                })),
                volumeMounts,
                resources: buildResources(item),
              },
              {
                name: 'db-proxy',
                image: this.getDbProxyImage(item.database),
                imagePullPolicy: 'IfNotPresent',
                ports: [
                  {
                    containerPort: this.getDbProxyPort(item.database),
                    name: 'query',
                  },
                ],
                env: this.buildDbProxyEnvVars(
                  item,
                  dbConfig.ports[0],
                  instanceId,
                  instanceItemId,
                ),
                resources: {
                  requests: { cpu: '50m', memory: '64Mi' },
                  limits: { cpu: '200m', memory: '128Mi' },
                },
              },
              {
                name: 'fluent-bit',
                image: DOKKIMI_IMAGES.fluentBit,
                imagePullPolicy: 'IfNotPresent',
                env: [
                  { name: 'INSTANCE_ID', value: instanceId },
                  { name: 'INSTANCE_ITEM_NAME', value: item.name },
                  { name: 'INSTANCE_ITEM_ID', value: instanceItemId },
                  {
                    name: 'POD_NAME',
                    valueFrom: {
                      fieldRef: { fieldPath: 'metadata.name' },
                    },
                  },
                  {
                    name: 'CONTROL_TOWER_URL',
                    value: buildServiceUrl(
                      getConfig().services.controlTower,
                      true,
                    ),
                  },
                ],
                volumeMounts: [
                  { name: 'varlog', mountPath: '/var/log', readOnly: true },
                  {
                    name: 'docker-containers',
                    mountPath: '/var/lib/docker/containers',
                    readOnly: true,
                  },
                  {
                    name: 'fluent-bit-config',
                    mountPath: '/fluent-bit/etc/fluent-bit.conf',
                    subPath: 'fluent-bit.conf',
                  },
                ],
                resources: FLUENT_BIT_RESOURCES,
              },
            ],
            volumes: [
              ...volumes,
              {
                name: 'varlog',
                hostPath: { path: '/var/log', type: 'Directory' },
              },
              {
                name: 'docker-containers',
                hostPath: {
                  path: '/var/lib/docker/containers',
                  type: 'DirectoryOrCreate',
                },
              },
              {
                name: 'fluent-bit-config',
                configMap: { name: 'dokkimi-interceptor-config' },
              },
            ],
          },
        },
      },
    };
  }

  buildDatabaseService(
    item: ItemDefinitionLike,
    namespace: string,
    ports: number[],
  ): k8s.V1Service {
    const deploymentName = item.k8sName;
    const isPostgres = this.isPostgresType(item.database);
    const proxyPort = this.getDbProxyPort(item.database);

    const servicePorts: Array<{
      port: number;
      targetPort: number;
      name: string;
    }> = [];

    if (
      isPostgres ||
      this.isMysqlType(item.database) ||
      this.isRedisType(item.database) ||
      this.isMongoType(item.database)
    ) {
      // Wire protocol proxy: external port routes to the proxy sidecar,
      // which forwards to the real DB on localhost inside the pod.
      servicePorts.push({
        port: ports[0],
        targetPort: proxyPort,
        name: 'query',
      });
    } else {
      // Other DBs: expose the real DB port directly + REST proxy on 8080
      servicePorts.push(
        ...ports.map((port) => ({
          port,
          targetPort: port,
          name: 'database',
        })),
        {
          port: 8080,
          targetPort: 8080,
          name: 'query',
        },
      );
    }

    return {
      metadata: { name: deploymentName, namespace },
      spec: {
        selector: { app: deploymentName },
        ports: servicePorts,
      },
    };
  }

  private getInitFileMountPath(
    databaseType: string | null | undefined,
  ): string | null {
    if (!databaseType) {
      return null;
    }

    const dbType = databaseType.toLowerCase();

    if (dbType === 'redis') {
      return null;
    }

    return '/docker-entrypoint-initdb.d';
  }

  private isPostgresType(databaseType: string | null | undefined): boolean {
    const dbType = (databaseType || '').toLowerCase();
    return dbType === 'postgres' || dbType === 'postgresql';
  }

  private isMysqlType(databaseType: string | null | undefined): boolean {
    const dbType = (databaseType || '').toLowerCase();
    return dbType === 'mysql' || dbType === 'mariadb';
  }

  private isRedisType(databaseType: string | null | undefined): boolean {
    const dbType = (databaseType || '').toLowerCase();
    return dbType === 'redis';
  }

  private isMongoType(databaseType: string | null | undefined): boolean {
    const dbType = (databaseType || '').toLowerCase();
    return dbType === 'mongodb';
  }

  private getDbProxyPort(databaseType: string | null | undefined): number {
    if (this.isPostgresType(databaseType)) {
      return 15432;
    }
    if (this.isMysqlType(databaseType)) {
      return 13306;
    }
    if (this.isRedisType(databaseType)) {
      return 16379;
    }
    if (this.isMongoType(databaseType)) {
      return 17017;
    }
    return 8080;
  }

  private getDbProxyImage(databaseType: string | null | undefined): string {
    if (!databaseType) {
      throw new Error('Database type is required for db-proxy');
    }

    const dbType = databaseType.toLowerCase();

    switch (dbType) {
      case 'postgres':
      case 'postgresql':
        return DOKKIMI_IMAGES.dbProxyPostgres;
      case 'mysql':
      case 'mariadb':
        return DOKKIMI_IMAGES.dbProxyMysql;
      case 'mongodb':
        return DOKKIMI_IMAGES.dbProxyMongo;
      case 'redis':
        return DOKKIMI_IMAGES.dbProxyRedis;
      default:
        throw new Error(`Unsupported database type for db-proxy: ${dbType}`);
    }
  }

  private buildDbProxyEnvVars(
    item: ItemDefinitionLike,
    databasePort: number,
    instanceId: string,
    instanceItemId: string,
  ): Array<{ name: string; value: string }> {
    const config = getConfig();

    const dbName = item.dbName ?? config.database.defaultName;
    const dbUser = item.dbUser ?? config.database.defaultUser;
    const dbPassword = item.dbPassword ?? config.database.defaultPassword;

    return buildDbProxyEnvVars(config, {
      databaseType: item.database || '',
      databasePort: String(databasePort),
      instanceItemName: item.name,
      namespace: instanceId,
      namespaceItemId: instanceItemId,
      testAgentUrl: `http://test-agent-service:${config.services.testAgent.port}`,
      dbUser,
      dbPassword,
      dbName,
    });
  }
}
