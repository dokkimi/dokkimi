import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RunStorageService } from './run-storage.service';
import { InitFilesController } from './init-files.controller';

@Module({
  imports: [PrismaModule],
  controllers: [InitFilesController],
  providers: [RunStorageService],
  exports: [RunStorageService],
})
export class StorageModule {}
