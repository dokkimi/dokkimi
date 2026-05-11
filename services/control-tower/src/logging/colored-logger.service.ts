import { Injectable, Inject, Optional, LoggerService } from '@nestjs/common';
import { RotatingFileWriter } from './rotating-file-writer';

// ANSI color codes
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

// Strip ANSI escape sequences for file output. The regex has to match the real
// ESC (0x1b) byte written by the color codes above, so the control char in the
// pattern is intentional.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Shared file writer — one per process, created lazily from the LOG_FILE env var.
 * Static so every ColoredLoggerService instance in the same process shares it.
 */
let fileWriter: RotatingFileWriter | null = null;

function getFileWriter(): RotatingFileWriter | null {
  if (fileWriter) {
    return fileWriter;
  }
  const logFile = process.env.LOG_FILE;
  if (!logFile) {
    return null;
  }
  fileWriter = new RotatingFileWriter(logFile);
  return fileWriter;
}

@Injectable()
export class ColoredLoggerService implements LoggerService {
  private context?: string;
  private readonly serviceName: string;
  private readonly serviceColor: string;

  constructor(
    @Optional() @Inject('SERVICE_NAME') serviceName?: string,
    @Optional() @Inject('SERVICE_COLOR') serviceColor?: string,
    @Optional() context?: string,
  ) {
    this.serviceName = serviceName || 'APP';
    this.serviceColor = serviceColor || '\x1b[37m'; // Default to white
    this.context = context;
  }

  /**
   * Factory method for creating logger instances directly (for bootstrap)
   * Use this when creating loggers outside of NestJS DI context
   */
  static create(
    serviceName: string,
    serviceColor: string,
    context?: string,
  ): ColoredLoggerService {
    return new (ColoredLoggerService as any)(
      serviceName,
      serviceColor,
      context,
    );
  }

  log(message: any, ...optionalParams: unknown[]) {
    const prefix = this.context ? `[${this.context}]` : '';
    this.output(
      'log',
      `${this.serviceColor}${BOLD}[${this.serviceName}]${RESET}${this.serviceColor}${prefix} ${message}${RESET}`,
      ...(optionalParams as []),
    );
  }

  error(message: any, trace?: unknown, ...optionalParams: unknown[]) {
    const prefix = this.context ? `[${this.context}]` : '';
    this.output(
      'error',
      `${this.serviceColor}${BOLD}[${this.serviceName}]${RESET}${this.serviceColor}${prefix} ${message}${RESET}`,
      ...(optionalParams as []),
    );
    if (trace) {
      const traceStr =
        trace instanceof Error
          ? (trace.stack ?? trace.message)
          : typeof trace === 'string'
            ? trace
            : String(trace);
      this.output('error', traceStr);
    }
  }

  warn(message: any, ...optionalParams: unknown[]) {
    const prefix = this.context ? `[${this.context}]` : '';
    this.output(
      'warn',
      `${this.serviceColor}${BOLD}[${this.serviceName}]${RESET}${this.serviceColor}${prefix} ${message}${RESET}`,
      ...(optionalParams as []),
    );
  }

  private output(
    level: 'log' | 'error' | 'warn',
    message: string,
    ...args: unknown[]
  ): void {
    const writer = getFileWriter();
    if (writer) {
      const clean = message.replace(ANSI_RE, '');
      const ts = new Date().toISOString();
      const extra = args.length ? ' ' + args.map(String).join(' ') : '';
      writer.write(`${ts} [${level.toUpperCase()}] ${clean}${extra}`);
    } else {
      console[level](message, ...(args as []));
    }
  }
}
