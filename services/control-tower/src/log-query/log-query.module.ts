import { Module } from '@nestjs/common';
import { LogQueryController } from './log-query.controller';
import { LogQueryService } from './log-query.service';
import { PrismaModule } from '../prisma/prisma.module';
import { LogProcessingModule } from '../log-processing/log-processing.module';

@Module({
  imports: [PrismaModule, LogProcessingModule],
  controllers: [LogQueryController],
  providers: [LogQueryService],
  exports: [LogQueryService],
})
export class LogQueryModule {}
