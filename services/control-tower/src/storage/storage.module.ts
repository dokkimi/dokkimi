import { Module } from '@nestjs/common';
import { RunStorageService } from './run-storage.service';
import { InitFilesController } from './init-files.controller';

@Module({
  controllers: [InitFilesController],
  providers: [RunStorageService],
  exports: [RunStorageService],
})
export class StorageModule {}
