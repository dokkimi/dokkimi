import { DynamicModule, Module } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';
import { TelemetryService } from './telemetry.service';
import { TelemetryInterceptor } from './telemetry.interceptor';
import { TelemetryExceptionFilter } from './telemetry-exception.filter';

export interface TelemetryModuleOptions {
  serviceName: string;
}

@Module({})
export class TelemetryModule {
  static forRoot(options: TelemetryModuleOptions): DynamicModule {
    return {
      module: TelemetryModule,
      global: true,
      providers: [
        { provide: 'TELEMETRY_SERVICE_NAME', useValue: options.serviceName },
        TelemetryService,
        { provide: APP_INTERCEPTOR, useClass: TelemetryInterceptor },
        { provide: APP_FILTER, useClass: TelemetryExceptionFilter },
      ],
      exports: [TelemetryService],
    };
  }
}
