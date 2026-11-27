import {
  Catch,
  ExceptionFilter,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import * as express from 'express';
import { TelemetryService } from './telemetry.service';

@Catch()
export class TelemetryExceptionFilter implements ExceptionFilter {
  constructor(private readonly telemetry: TelemetryService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<express.Request>();
    const response = ctx.getResponse<express.Response>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    // Only what identifies the kind of error: before, the event had the URL
    // with its query (project paths) and the message (file paths, names)
    const code = (exception as { code?: unknown } | null)?.code;
    this.telemetry.track('service_error', {
      error_type:
        exception instanceof Error ? exception.constructor.name : 'Unknown',
      ...(typeof code === 'string' ? { error_code: code } : {}),
      route:
        (request.route as { path?: string } | undefined)?.path ?? 'unmatched',
      method: request.method,
      status_code: status,
    });

    // Re-throw so NestJS default handling still applies
    if (exception instanceof HttpException) {
      response.status(status).json(exception.getResponse());
    } else {
      response.status(status).json({
        statusCode: status,
        message: 'Internal server error',
      });
    }
  }
}
