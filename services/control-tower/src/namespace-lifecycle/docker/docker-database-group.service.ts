import * as fs from 'fs';
import { Injectable, Logger } from '@nestjs/common';
import { getConfig, buildDbProxyEnvVars } from '@dokkimi/config';
import { DockerClientService } from './docker-client.service';
import { DOKKIMI_IMAGES } from '../../constants/image-tags';
import { DefinitionItem } from '../deployment-context.types';
import { DatabaseConfigService } from '../builders/database-config.service';
import { RunStorageService } from '../../storage/run-storage.service';
import { envArrayToRecord } from './env.utils';

@Injectable()
export class DockerDatabaseGroupService {
  private readonly logger = new Logger(DockerDatabaseGroupService.name);

  constructor(
    private readonly dockerClient: DockerClientService,
    private readonly databaseConfig: DatabaseConfigService,
    private readonly runStorage: RunStorageService,
  ) {}

  async createDatabaseGroup(
    networkName: string,
    instanceId: string,
    item: DefinitionItem,
    containerName: string,
    instanceItemId: string,
  ): Promise<void> {
    if (!item.database) {
      this.logger.warn(`Skipping database ${item.name} — no database type`);
      return;
    }

    const config = getConfig();
    const dbConfig = this.databaseConfig.getConfig(
      item.database,
      {
        dbName: item.dbName ?? undefined,
        dbUser: item.dbUser ?? undefined,
        dbPassword: item.dbPassword ?? undefined,
      },
      item.version ?? undefined,
    );

    const dbProxyImage = this.getDbProxyImage(item.database);
    const nativePort = dbConfig.ports[0];
    const internalPort = this.getDbInternalPort(item.database);
    const isMongo = item.database?.toLowerCase() === 'mongodb';

    const dbProxyName = `${containerName}-dbproxy-${instanceId}`;
    const dbContainerName = `${containerName}-db-${instanceId}`;

    const dbProxyEnvEntries = buildDbProxyEnvVars(config, {
      databaseType: item.database,
      databasePort: String(internalPort),
      instanceItemName: item.name,
      namespace: instanceId,
      namespaceItemId: instanceItemId,
      testAgentUrl: `http://test-agent-service:${config.services.testAgent.port}`,
      dbUser: item.dbUser ?? config.database.defaultUser,
      dbPassword: item.dbPassword ?? config.database.defaultPassword,
      dbName: item.dbName ?? config.database.defaultName,
    });
    const dbProxyEnv = envArrayToRecord(dbProxyEnvEntries);
    dbProxyEnv.QUERY_PORT = String(nativePort);

    const dbEnv: Record<string, string> = { ...dbConfig.environment };
    this.setDbInternalPortEnv(dbEnv, item.database, internalPort);

    const initFileMountPath = this.getInitFileMountPath(item.database);
    const dbBinds: string[] = [];
    if ((item.initFiles?.length || isMongo) && initFileMountPath) {
      const storageInitDir = this.runStorage.getInitFilesDir(
        instanceId,
        item.name,
      );
      if (fs.existsSync(storageInitDir)) {
        dbBinds.push(`${storageInitDir}:${initFileMountPath}:ro`);
      }
    }

    const dbCmd = this.getDbCommand(
      item.database,
      internalPort,
      dbConfig.command,
    );

    await this.dockerClient.runContainer({
      name: dbProxyName,
      image: dbProxyImage,
      networkName,
      networkAliases: [containerName],
      env: dbProxyEnv,
      exposedPorts: [nativePort, internalPort],
      labels: {
        'io.dokkimi.instance-id': instanceId,
        'io.dokkimi.role': 'db-proxy',
        'io.dokkimi.item-name': item.name,
      },
    });

    const mongoEntrypoint = isMongo
      ? this.buildMongoEntrypoint(internalPort, dbEnv, initFileMountPath)
      : undefined;

    await this.dockerClient.runContainer({
      name: dbContainerName,
      image: dbConfig.image,
      networkName,
      networkMode: `container:${dbProxyName}`,
      env: dbEnv,
      binds: dbBinds,
      ...(isMongo
        ? { entrypoint: ['/bin/bash', '-c', mongoEntrypoint!], cmd: undefined }
        : dbCmd
          ? { cmd: dbCmd }
          : {}),
      exposedPorts: [internalPort],
      labels: {
        'io.dokkimi.instance-id': instanceId,
        'io.dokkimi.role': 'database',
        'io.dokkimi.item-name': item.name,
      },
    });

    this.logger.log(
      `Created database group for ${item.name} (${item.database})`,
    );
  }

  getDbProxyImage(databaseType: string): string {
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

  private getDbInternalPort(databaseType: string): number {
    const dbType = databaseType.toLowerCase();
    if (dbType === 'postgres' || dbType === 'postgresql') {
      return 55432;
    }
    if (dbType === 'mysql' || dbType === 'mariadb') {
      return 33306;
    }
    if (dbType === 'redis') {
      return 63790;
    }
    if (dbType === 'mongodb') {
      return 27018;
    }
    return 18080;
  }

  private setDbInternalPortEnv(
    env: Record<string, string>,
    databaseType: string,
    internalPort: number,
  ): void {
    const dbType = databaseType.toLowerCase();
    if (dbType === 'postgres' || dbType === 'postgresql') {
      env.PGPORT = String(internalPort);
    } else if (dbType === 'mysql' || dbType === 'mariadb') {
      env.MYSQL_TCP_PORT = String(internalPort);
    }
  }

  private getDbCommand(
    databaseType: string,
    internalPort: number,
    baseCommand?: string[],
  ): string[] | undefined {
    const dbType = databaseType.toLowerCase();
    if (dbType === 'redis') {
      const args = baseCommand ? [...baseCommand] : ['redis-server'];
      args.push('--port', String(internalPort));
      return args;
    }
    return baseCommand;
  }

  private buildMongoEntrypoint(
    internalPort: number,
    env: Record<string, string>,
    initFileMountPath: string | null,
  ): string {
    const user = env.MONGO_INITDB_ROOT_USERNAME || '';
    const pass = env.MONGO_INITDB_ROOT_PASSWORD || '';
    const hasAuth = !!(user && pass);

    const initBlock = initFileMountPath
      ? `
if [ -d "${initFileMountPath}" ]; then
  for f in ${initFileMountPath}/*; do
    case "$f" in
      *.sh)  echo "Running $f"; . "$f" ;;
      *.js)  echo "Running $f"; mongosh --port ${internalPort} "$f" ;;
    esac
  done
fi`
      : '';

    if (hasAuth) {
      return `
mongod --port ${internalPort} --bind_ip_all --fork --logpath /proc/1/fd/1
until mongosh --port ${internalPort} --eval "db.adminCommand('ping')" &>/dev/null; do sleep 0.5; done
mongosh --port ${internalPort} admin --eval "db.createUser({user:'${user}',pwd:'${pass}',roles:[{role:'root',db:'admin'}]});"
${initBlock}
mongod --port ${internalPort} --shutdown
exec mongod --port ${internalPort} --bind_ip_all --auth`;
    }

    return `
mongod --port ${internalPort} --bind_ip_all --fork --logpath /proc/1/fd/1
until mongosh --port ${internalPort} --eval "db.adminCommand('ping')" &>/dev/null; do sleep 0.5; done
${initBlock}
mongod --port ${internalPort} --shutdown
exec mongod --port ${internalPort} --bind_ip_all`;
  }

  private getInitFileMountPath(databaseType: string): string | null {
    const dbType = databaseType.toLowerCase();
    if (dbType === 'redis') {
      return null;
    }
    return '/docker-entrypoint-initdb.d';
  }
}
