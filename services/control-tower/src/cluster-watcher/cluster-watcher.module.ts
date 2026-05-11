import { Module } from '@nestjs/common';
import { WatcherService } from './watcher.service';
import { PrismaModule } from '../prisma/prisma.module';
import { RunsModule } from '../runs/runs.module';

@Module({
  imports: [PrismaModule, RunsModule],
  providers: [WatcherService],
  exports: [WatcherService],
})
export class ClusterWatcherModule {}
