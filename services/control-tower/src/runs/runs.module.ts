import { Module } from '@nestjs/common';
import { RunsController } from './runs.controller';
import { TestCompletionController } from './test-completion.controller';
import { RunsService } from './runs.service';
import { RunCleanupService } from './run-cleanup.service';
import { DeploymentSchedulerService } from './deployment-scheduler.service';
import { NamespaceLifecycleModule } from '../namespace-lifecycle/namespace-lifecycle.module';
import { StorageModule } from '../storage/storage.module';
import { PrismaModule } from '../prisma/prisma.module';
@Module({
  imports: [NamespaceLifecycleModule, StorageModule, PrismaModule],
  controllers: [RunsController, TestCompletionController],
  providers: [RunsService, RunCleanupService, DeploymentSchedulerService],
  exports: [RunsService],
})
export class RunsModule {}
