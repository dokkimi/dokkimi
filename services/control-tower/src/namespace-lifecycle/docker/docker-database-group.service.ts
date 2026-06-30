import * as fs from 'fs';
import { Injectable, Logger } from '@nestjs/common';
import { getConfig, buildDbProxyEnvVars } from '@dokkimi/config';
import { DockerClientService } from './docker-client.service';
import { DOKKIMI_IMAGES } from '../../constants/image-tags';
import { DefinitionItem } from '../deployment-context.types';
import {
  DatabaseConfigService,
  resolveDbCredentials,
} from '../builders/database-config.service';
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
    const resolved = resolveDbCredentials(item);
    const dbConfig = this.databaseConfig.getConfig(
      item.database,
      {
        dbName: item.dbName ?? undefined,
        dbUser: item.dbUser ?? undefined,
        dbPassword: item.dbPassword ?? undefined,
        noAuth: item.noAuth ?? undefined,
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
      dbUser: resolved.dbUser,
      dbPassword: resolved.dbPassword,
      dbName: resolved.dbName,
    });
    const dbProxyEnv = envArrayToRecord(dbProxyEnvEntries);
    dbProxyEnv.QUERY_PORT = String(nativePort);

    const dbEnv: Record<string, string> = { ...dbConfig.environment };
    this.setDbInternalPortEnv(dbEnv, item.database, internalPort);

    const initFileMountPath = this.getInitFileMountPath(item.database);
    const dbBinds: string[] = [];
    if ((item.initFiles?.length || isMongo) && initFileMountPath) {
      const storageInitDir = await this.runStorage.getInitFilesDir(
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

    const dbTmpfs = this.getDbTmpfs(item.database);

    await this.dockerClient.runContainer({
      name: dbContainerName,
      image: item.image || dbConfig.image,
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
      ...(dbTmpfs ? { tmpfs: dbTmpfs } : {}),
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
    const hasAuth = !!(
      env.MONGO_INITDB_ROOT_USERNAME && env.MONGO_INITDB_ROOT_PASSWORD
    );

    const mongoshAuth = hasAuth
      ? ` -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin`
      : '';

    const initBlock = initFileMountPath
      ? `
if [ -d "${initFileMountPath}" ]; then
  for f in ${initFileMountPath}/*; do
    case "$f" in
      *.sh)  echo "Running $f"; . "$f" ;;
      *.js)  echo "Running $f"; mongosh --port ${internalPort}${mongoshAuth} "$f" ;;
    esac
  done
fi`
      : '';

    const authFlag = hasAuth ? ' --auth' : '';
    const createUserBlock = hasAuth
      ? `mongosh --port ${internalPort} admin --eval "db.createUser({user:process.env.MONGO_INITDB_ROOT_USERNAME,pwd:process.env.MONGO_INITDB_ROOT_PASSWORD,roles:[{role:'root',db:'admin'}]});"\n`
      : '';

    return `
mongod --port ${internalPort} --bind_ip_all${authFlag} &
MONGOD_PID=$!
until mongosh --port ${internalPort} --eval "db.adminCommand('ping')" &>/dev/null; do sleep 0.5; done
${createUserBlock}${initBlock}
wait $MONGOD_PID`;
  }

  private getDbTmpfs(databaseType: string): Record<string, string> | undefined {
    const dbType = databaseType.toLowerCase();
    switch (dbType) {
      case 'mysql':
      case 'mariadb':
        return { '/var/lib/mysql': '' };
      case 'postgres':
      case 'postgresql':
        return { '/var/lib/postgresql/data': '' };
      case 'mongodb':
        return { '/data/db': '' };
      default:
        return undefined;
    }
  }

  private getInitFileMountPath(databaseType: string): string | null {
    const dbType = databaseType.toLowerCase();
    if (dbType === 'redis') {
      return null;
    }
    return '/docker-entrypoint-initdb.d';
  }
}
