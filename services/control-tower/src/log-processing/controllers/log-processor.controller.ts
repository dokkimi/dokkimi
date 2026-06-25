import {
  Controller,
  Post,
  Body,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { TelemetryService } from '../../telemetry/telemetry.service';
import { HttpLogProcessorService } from '../processors/http-log-processor.service';
import { ConsoleLogProcessorService } from '../processors/console-log-processor.service';
import { DatabaseLogProcessorService } from '../processors/database-log-processor.service';
import { MessageLogProcessorService } from '../processors/message-log-processor.service';
import { TestExecutionLogProcessorService } from '../processors/test-execution-log-processor.service';
import { TestValidationLogProcessorService } from '../processors/test-validation-log-processor.service';
import { HttpLogMessageDto } from '../dto/http-log-message.dto';
import { RawConsoleLogDto } from '../dto/raw-console-log.dto';
import { DatabaseLogMessageDto } from '../dto/database-log-message.dto';
import { TestExecutionLogMessageDto } from '../dto/test-execution-log-message.dto';
import { MessageLogMessageDto } from '../dto/message-log-message.dto';
import { TestValidationLogMessageDto } from '../dto/test-validation-log-message.dto';

const BATCH_INTERVAL_MS = 30_000; // 30 seconds

@SkipThrottle() // Skip rate limiting for log ingestion endpoints - designed for high volume
@Controller('logs')
export class LogProcessorController implements OnModuleInit, OnModuleDestroy {
  private httpLogCount = 0;
  private consoleLogCount = 0;
  private databaseLogCount = 0;
  private messageLogCount = 0;
  private testExecutionLogCount = 0;
  private testValidationLogCount = 0;
  private batchTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly httpLogProcessor: HttpLogProcessorService,
    private readonly consoleLogProcessor: ConsoleLogProcessorService,
    private readonly databaseLogProcessor: DatabaseLogProcessorService,
    private readonly messageLogProcessor: MessageLogProcessorService,
    private readonly testExecutionLogProcessor: TestExecutionLogProcessorService,
    private readonly testValidationLogProcessor: TestValidationLogProcessorService,
    private readonly telemetry: TelemetryService,
  ) {}

  onModuleInit() {
    this.batchTimer = setInterval(
      () => this.flushBatchTelemetry(),
      BATCH_INTERVAL_MS,
    );
  }

  onModuleDestroy() {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
    this.flushBatchTelemetry();
  }

  private flushBatchTelemetry() {
    const total =
      this.httpLogCount +
      this.consoleLogCount +
      this.databaseLogCount +
      this.messageLogCount +
      this.testExecutionLogCount +
      this.testValidationLogCount;
    if (total === 0) {
      return;
    }

    this.telemetry.track('lps_logs_batch', {
      module: 'log-processing',
      http_log_count: this.httpLogCount,
      console_log_count: this.consoleLogCount,
      database_log_count: this.databaseLogCount,
      message_log_count: this.messageLogCount,
      test_execution_log_count: this.testExecutionLogCount,
      test_validation_log_count: this.testValidationLogCount,
      interval_ms: BATCH_INTERVAL_MS,
    });

    this.httpLogCount = 0;
    this.consoleLogCount = 0;
    this.databaseLogCount = 0;
    this.messageLogCount = 0;
    this.testExecutionLogCount = 0;
    this.testValidationLogCount = 0;
  }

  @Post('http')
  async receiveHttpLog(@Body() message: HttpLogMessageDto) {
    await this.httpLogProcessor.process(message, message.instanceId);
    this.httpLogCount++;
    return { received: true };
  }

  @Post('console')
  async receiveConsoleLog(
    @Body() message: RawConsoleLogDto | RawConsoleLogDto[],
  ) {
    await this.consoleLogProcessor.processRawLogs(message);
    this.consoleLogCount += Array.isArray(message) ? message.length : 1;
    return { received: true };
  }

  @Post('database')
  async receiveDatabaseLog(@Body() message: DatabaseLogMessageDto) {
    await this.databaseLogProcessor.process(message, message.instanceId);
    this.databaseLogCount++;
    return { received: true };
  }

  @Post('message')
  async receiveMessageLog(@Body() message: MessageLogMessageDto) {
    await this.messageLogProcessor.process(message, message.instanceId);
    this.messageLogCount++;
    return { received: true };
  }

  @Post('test-execution')
  async receiveTestExecutionLog(@Body() message: TestExecutionLogMessageDto) {
    await this.testExecutionLogProcessor.process(message, message.instanceId);
    this.testExecutionLogCount++;
    return { received: true };
  }

  @Post('test-validation')
  async receiveTestValidationLog(@Body() message: TestValidationLogMessageDto) {
    await this.testValidationLogProcessor.process(message, message.instanceId);
    this.testValidationLogCount++;
    return { received: true };
  }
}
