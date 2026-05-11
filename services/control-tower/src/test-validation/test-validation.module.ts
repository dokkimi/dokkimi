import { Module, forwardRef } from '@nestjs/common';
import { TestValidationController } from './controllers/test-validation.controller';
import { TestValidationService } from './test-validation.service';
import { StepValidatorService } from './step-validator.service';
import { AssertionValidatorService } from './assertion-validator.service';
import { VariableContextService } from './variable-context.service';
import { QuiescenceDetectionService } from './quiescence-detection.service';
import { LoopDetectionService } from './loop-detection.service';
import { DocumentAssemblerService } from './document-assembler.service';
import { LogFinderService } from './log-finder.service';
import { ConsoleLogBlockValidatorService } from './block-validators/console-log-block-validator.service';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { RunsModule } from '../runs/runs.module';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { LogProcessingModule } from '../log-processing/log-processing.module';

@Module({
  imports: [
    PrismaModule,
    StorageModule,
    ArtifactsModule,
    LogProcessingModule,
    forwardRef(() => RunsModule),
  ],
  controllers: [TestValidationController],
  providers: [
    TestValidationService,
    StepValidatorService,
    AssertionValidatorService,
    DocumentAssemblerService,
    LogFinderService,
    ConsoleLogBlockValidatorService,
    VariableContextService,
    QuiescenceDetectionService,
    LoopDetectionService,
  ],
  exports: [TestValidationService],
})
export class TestValidationModule {}
