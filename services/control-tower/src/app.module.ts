import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { LoggingModule } from './logging/logging.module';
import { LoggingInterceptor } from './logging/logging.interceptor';
import { TelemetryModule } from './telemetry/telemetry.module';
import { NamespaceModule } from './namespace/namespace.module';
import { HealthModule } from './health/health.module';
import { LogQueryModule } from './log-query/log-query.module';
import { RunsModule } from './runs/runs.module';
import { LogProcessingModule } from './log-processing/log-processing.module';
import { TestValidationModule } from './test-validation/test-validation.module';
import { ArtifactsModule } from './artifacts/artifacts.module';
import { BaselinesModule } from './baselines/baselines.module';
import { StorageModule } from './storage/storage.module';
import { getConfig, getConcurrencyPrefs } from '@dokkimi/config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        () => {
          const config = getConfig();
          return {
            DATABASE_URL: config.database.url,
            STORAGE_DIR: config.storage.dir,
            INIT_FILES_DIR: config.storage.initFilesDir,
            MAX_CONCURRENT_NAMESPACES:
              getConcurrencyPrefs().maxConcurrentTests ??
              config.concurrency.maxConcurrentTests,
            MAX_BOOTING_NAMESPACES:
              getConcurrencyPrefs().maxBootingTests ??
              config.concurrency.maxBootingTests,
            CIRCUIT_BREAKER_TIMEOUT: config.circuitBreaker?.timeout ?? 3000,
            CIRCUIT_BREAKER_ERROR_THRESHOLD:
              config.circuitBreaker?.errorThresholdPercentage ?? 50,
            CIRCUIT_BREAKER_RESET_TIMEOUT:
              config.circuitBreaker?.resetTimeout ?? 30000,
          };
        },
      ],
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60000, // 1 minute
        limit: 100, // 100 requests per minute (log ingestion uses @SkipThrottle)
      },
    ]),
    PrismaModule,
    LoggingModule.forRoot({ serviceName: 'CT', serviceColor: '\x1b[36m' }),
    TelemetryModule.forRoot({ serviceName: 'control-tower' }),
    NamespaceModule,
    HealthModule,
    LogQueryModule,
    RunsModule,
    LogProcessingModule,
    TestValidationModule,
    ArtifactsModule,
    BaselinesModule,
    StorageModule,
  ],
  controllers: [],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
  ],
})
export class AppModule {}
