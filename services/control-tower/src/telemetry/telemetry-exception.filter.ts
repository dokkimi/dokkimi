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

    const errorMessage =
      exception instanceof Error ? exception.message : String(exception);

    this.telemetry.track('service_error', {
      error_type:
        exception instanceof Error ? exception.constructor.name : 'Unknown',
      error_message: errorMessage.slice(0, 200),
      route: request.url,
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
