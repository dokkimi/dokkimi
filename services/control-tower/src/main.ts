import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { ColoredLoggerService } from './logging/colored-logger.service';
import { v4 as uuidv4 } from 'uuid';
import * as express from 'express';
import { loadConfig, getConfig } from '@dokkimi/config';

// ANSI color codes
const RESET = '\x1b[0m';
const TEAL = '\x1b[36m';
const BOLD = '\x1b[1m';

async function bootstrap() {
  // Load centralized configuration FIRST before anything else
  try {
    loadConfig();
  } catch (error) {
    console.error('[CT] Failed to load configuration:', error);
    process.exit(1);
  }

  const dokkimiConfig = getConfig();

  const app = await NestFactory.create(AppModule, {
    logger: ColoredLoggerService.create('CT', '\x1b[36m'),
    bodyParser: true,
    rawBody: false,
  });

  // Enable CORS for frontend access
  const corsOrigins = dokkimiConfig.cors?.origins || [];
  const corsPatterns = dokkimiConfig.cors?.allowAnyLocalhost
    ? [/^http:\/\/localhost:\d+$/]
    : [];

  app.enableCors({
    origin: [...corsOrigins, ...corsPatterns],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  });

  // Request size limits (10MB for JSON)
  app.use(
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (req.headers['content-length']) {
        const contentLength = parseInt(req.headers['content-length'], 10);
        const maxSize = 10 * 1024 * 1024; // 10MB
        if (contentLength > maxSize) {
          return res.status(413).json({
            statusCode: 413,
            message: 'Request entity too large',
            error: 'Payload Too Large',
          });
        }
      }
      next();
    },
  );

  // Request ID middleware for traceability
  app.use(
    (
      req: express.Request & { requestId?: string },
      res: express.Response,
      next: express.NextFunction,
    ) => {
      const requestId =
        (req.headers['x-request-id'] as string) ||
        (req.headers['x-correlation-id'] as string) ||
        uuidv4();
      req.requestId = requestId;
      res.setHeader('X-Request-ID', requestId);
      next();
    },
  );

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Strip unknown properties
      forbidNonWhitelisted: true, // Reject unknown properties
      transform: true, // Auto-transform to DTOs
      transformOptions: {
        enableImplicitConversion: true, // Auto-convert types
      },
      disableErrorMessages: false, // Show validation errors
    }),
  );

  const port = dokkimiConfig.services.controlTower.port;

  console.log(
    `${TEAL}${BOLD}[CT]${RESET}${TEAL} Control Tower running on http://localhost:${port}${RESET}`,
  );

  await app.listen(port);

  const shutdown = () => {
    console.log(
      `${TEAL}${BOLD}[CT]${RESET}${TEAL} Shutting down gracefully...${RESET}`,
    );
    void app.close().then(() => process.exit(0));
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
void bootstrap();
