import { Module } from '@nestjs/common';
import { BaselinesController } from './baselines.controller';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule],
  controllers: [BaselinesController],
})
export class BaselinesModule {}
