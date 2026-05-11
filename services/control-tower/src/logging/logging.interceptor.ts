import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Inject,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import * as express from 'express';
import { ColoredLoggerService } from './colored-logger.service';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger: ColoredLoggerService;

  constructor(@Inject(ColoredLoggerService) logger: ColoredLoggerService) {
    this.logger = logger;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<express.Request>();
    const { method, url } = request;
    const startTime = Date.now();

    return next.handle().pipe(
      tap({
        error: (error: unknown) => {
          const duration = Date.now() - startTime;
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error';
          const errorStack = error instanceof Error ? error.stack : undefined;
          this.logger.error(
            `${method} ${url} - ${duration}ms - Error: ${errorMessage}`,
            errorStack,
          );
        },
      }),
    );
  }
}
