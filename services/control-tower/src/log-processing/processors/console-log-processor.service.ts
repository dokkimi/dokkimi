import { Injectable, Logger } from '@nestjs/common';
import { ConsoleLogMessage } from '../../types/messages';
import { StorageService } from '../storage.service';
import { NamespaceValidationService } from '../namespace-validation/namespace-validation.service';
import { RawConsoleLogDto } from '../dto/raw-console-log.dto';

@Injectable()
export class ConsoleLogProcessorService {
  private readonly logger = new Logger(ConsoleLogProcessorService.name);

  constructor(
    private readonly storage: StorageService,
    private readonly namespaceValidation: NamespaceValidationService,
  ) {}

  /**
   * Processes raw console log messages from container stdout/stderr.
   * Accepts: { log, stream, time, instanceId, instanceItemId } or array of these
   */
  async processRawLogs(
    message: RawConsoleLogDto | RawConsoleLogDto[],
  ): Promise<void> {
    const messages = Array.isArray(message) ? message : [message];

    for (const msg of messages) {
      if (!msg.instanceId) {
        this.logger.warn(
          `Skipping log without instanceId: ${JSON.stringify(msg)}`,
        );
        continue;
      }

      try {
        // Parse CRI format from log line: <timestamp> <stream> <tag> <log>
        // Example: 2025-11-27T17:50:38.989944416Z stdout F [INFO] Service heartbeat
        const parsed = this.parseCRILogLine(msg.log);

        // Parse log level from the message (look for [INFO], [WARN], [ERROR], [DEBUG])
        const level = this.parseLogLevel(parsed.message);

        // Create the formatted console log message
        const consoleLog: ConsoleLogMessage = {
          instanceId: msg.instanceId,
          instanceItemId: msg.instanceItemId,
          level,
          message: parsed.message,
          timestamp: parsed.timestamp || msg.time || new Date().toISOString(),
        };

        await this.process(consoleLog, consoleLog.instanceId);
      } catch (error) {
        this.logger.error(
          `Error processing console log: ${JSON.stringify(msg)}`,
          error,
        );
        // Continue processing other messages
      }
    }
  }

  /**
   * Processes a console log message
   */
  async process(message: ConsoleLogMessage, instanceId: string): Promise<void> {
    try {
      // Validate instance exists
      const isValid =
        await this.namespaceValidation.validateInstance(instanceId);
      if (!isValid) {
        this.logger.warn(
          `Skipping console log for invalid instance: ${instanceId}`,
        );
        return;
      }

      await this.storage.storeConsoleLog(message);
    } catch (error) {
      this.logger.error(`Error processing console log:`, error);
      throw error;
    }
  }

  /**
   * Parses a CRI log line format: <timestamp> <stream> <tag> <log>
   * Also handles JSON-wrapped logs: {"log":"...", "stream":"stdout", "time":"..."}
   * Returns the timestamp and the actual log message
   */
  private parseCRILogLine(line: string): {
    timestamp?: string;
    message: string;
  } {
    if (!line) {
      return { message: '' };
    }

    // First, check if it's JSON-wrapped
    // Format: {"log":"actual message\n","stream":"stdout","time":"2026-01-25T20:40:53.405954346Z"}
    if (line.startsWith('{')) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.log) {
          // Remove trailing newline from log message
          const logMessage = parsed.log.replace(/\n$/, '');
          return {
            timestamp: parsed.time,
            message: logMessage,
          };
        }
      } catch {
        // Not valid JSON, fall through to CRI parsing
      }
    }

    // CRI format: timestamp stream tag log
    // Example: 2025-11-27T17:50:38.989944416Z stdout F [INFO] Service heartbeat
    const criRegex =
      /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(stdout|stderr)\s+[^\s]+\s+(.*)$/;
    const match = line.match(criRegex);

    if (match) {
      return {
        timestamp: match[1],
        message: match[3], // The actual log message
      };
    }

    // If it doesn't match CRI format, return the whole line as the message
    return { message: line };
  }

  /**
   * Parses log level from a log message
   * Looks for patterns like [INFO], [WARN], [ERROR], [DEBUG]
   * Defaults to INFO if no level is found
   */
  private parseLogLevel(message: string): 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' {
    if (!message) {
      return 'INFO';
    }

    const upperMessage = message.toUpperCase();

    if (upperMessage.includes('[ERROR]') || upperMessage.includes('ERROR:')) {
      return 'ERROR';
    }
    if (upperMessage.includes('[WARN]') || upperMessage.includes('WARN:')) {
      return 'WARN';
    }
    if (upperMessage.includes('[DEBUG]') || upperMessage.includes('DEBUG:')) {
      return 'DEBUG';
    }
    if (upperMessage.includes('[INFO]') || upperMessage.includes('INFO:')) {
      return 'INFO';
    }

    // Default to INFO if no level is detected
    return 'INFO';
  }
}
