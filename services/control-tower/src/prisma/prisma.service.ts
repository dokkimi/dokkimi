import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private prisma: PrismaClient;

  constructor(private configService: ConfigService) {
    const databaseUrl = this.configService.get<string>('DATABASE_URL');
    if (!databaseUrl) {
      throw new Error(
        'DATABASE_URL is not set. Make sure it is configured in ConfigModule.',
      );
    }

    if (databaseUrl.startsWith('file:')) {
      const adapter = new PrismaLibSql({ url: databaseUrl });
      this.prisma = new PrismaClient({ adapter });
    } else {
      const pool = new Pool({ connectionString: databaseUrl });
      pool.on('error', (err: Error) => {
        this.logger.warn(`pg pool background error: ${err.message}`);
      });
      const adapter = new PrismaPg(pool);
      this.prisma = new PrismaClient({ adapter });
    }
  }

  get client(): PrismaClient {
    return this.prisma;
  }

  // Instance layer models
  get namespaceInstance(): PrismaClient['namespaceInstance'] {
    return this.prisma.namespaceInstance;
  }

  get instanceItem(): PrismaClient['instanceItem'] {
    return this.prisma.instanceItem;
  }

  // Log/metric models
  get httpLog(): PrismaClient['httpLog'] {
    return this.prisma.httpLog;
  }

  get consoleLog(): PrismaClient['consoleLog'] {
    return this.prisma.consoleLog;
  }

  get databaseLog(): PrismaClient['databaseLog'] {
    return this.prisma.databaseLog;
  }

  get testExecutionLog(): PrismaClient['testExecutionLog'] {
    return this.prisma.testExecutionLog;
  }

  // Validation models
  get assertionResult(): PrismaClient['assertionResult'] {
    return this.prisma.assertionResult;
  }

  // Artifact storage (UI-test screenshots, diffs, failure HTML)
  get artifact(): PrismaClient['artifact'] {
    return this.prisma.artifact;
  }

  // Run model
  get run(): PrismaClient['run'] {
    return this.prisma.run;
  }

  // Raw query execution
  $queryRaw<T = unknown>(
    query: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ): Prisma.PrismaPromise<T> {
    return this.prisma.$queryRaw(query, ...values);
  }

  async onModuleInit() {
    await this.connectWithRetry();
    await this.verifySchema();
  }

  private async connectWithRetry(
    maxAttempts = 10,
    delayMs = 2000,
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.prisma.$connect();
        await this.prisma.$queryRawUnsafe('SELECT 1');
        return;
      } catch (err) {
        if (attempt === maxAttempts) {
          throw err;
        }
        this.logger.warn(
          `Database connection attempt ${attempt}/${maxAttempts} failed, retrying in ${delayMs}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  async onModuleDestroy() {
    await this.prisma.$disconnect();
  }

  /**
   * Verifies that the database has been migrated. Prisma creates the
   * `_prisma_migrations` table on first `migrate deploy`; its absence means
   * migrations never ran — which produces a flurry of confusing
   * "table does not exist" errors later. Detect it early and surface a
   * clear remediation message instead.
   */
  private async verifySchema(): Promise<void> {
    try {
      await this.prisma.$queryRawUnsafe(
        'SELECT 1 FROM _prisma_migrations LIMIT 1',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // SQLite: "no such table", Postgres: "does not exist"
      if (/no such table|does not exist/i.test(msg)) {
        throw new Error(
          'Dokkimi database schema is not initialized — no migrations have been applied.\n' +
            '\n' +
            'To fix (desktop / SQLite):\n' +
            '  1. dokkimi shutdown\n' +
            '  2. rm ~/.dokkimi/dokkimi.db\n' +
            '  3. dokkimi run\n' +
            '\n' +
            'If that still fails, reinstall: npm install -g dokkimi',
          { cause: err },
        );
      }
      throw err;
    }
  }
}
