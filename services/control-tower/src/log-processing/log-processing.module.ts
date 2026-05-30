import { Module } from '@nestjs/common';
import { LogProcessorController } from './controllers/log-processor.controller';
import { StorageService } from './storage.service';
import { HttpLogProcessorService } from './processors/http-log-processor.service';
import { ConsoleLogProcessorService } from './processors/console-log-processor.service';
import { DatabaseLogProcessorService } from './processors/database-log-processor.service';
import { TestExecutionLogProcessorService } from './processors/test-execution-log-processor.service';
import { UiTimelineService } from './ui-timeline.service';
import { InFlightTrackerService } from './in-flight-tracker.service';
import { NamespaceValidationModule } from './namespace-validation/namespace-validation.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [NamespaceValidationModule, PrismaModule],
  controllers: [LogProcessorController],
  providers: [
    StorageService,
    HttpLogProcessorService,
    ConsoleLogProcessorService,
    DatabaseLogProcessorService,
    TestExecutionLogProcessorService,
    UiTimelineService,
    InFlightTrackerService,
  ],
  exports: [UiTimelineService, InFlightTrackerService, ConsoleLogProcessorService],
})
export class LogProcessingModule {}
