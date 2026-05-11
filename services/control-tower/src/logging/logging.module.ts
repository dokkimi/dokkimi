import { DynamicModule, Module } from '@nestjs/common';
import { ColoredLoggerService } from './colored-logger.service';
import { LoggingInterceptor } from './logging.interceptor';

export interface LoggingModuleOptions {
  serviceName: string;
  serviceColor: string;
}

@Module({})
export class LoggingModule {
  static forRoot(options: LoggingModuleOptions): DynamicModule {
    return {
      module: LoggingModule,
      global: true,
      providers: [
        { provide: 'SERVICE_NAME', useValue: options.serviceName },
        { provide: 'SERVICE_COLOR', useValue: options.serviceColor },
        ColoredLoggerService,
        LoggingInterceptor,
      ],
      exports: [ColoredLoggerService, LoggingInterceptor],
    };
  }
}
