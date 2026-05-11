import { Module } from '@nestjs/common';
import { ArtifactsController } from './artifacts.controller';
import { ArtifactsService } from './artifacts.service';
import { VisualMatchService } from './visual-match.service';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [PrismaModule, StorageModule],
  controllers: [ArtifactsController],
  providers: [ArtifactsService, VisualMatchService],
  exports: [ArtifactsService, VisualMatchService],
})
export class ArtifactsModule {}
