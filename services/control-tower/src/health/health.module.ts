import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NamespaceLifecycleModule } from '../namespace-lifecycle/namespace-lifecycle.module';

@Module({
  imports: [PrismaModule, NamespaceLifecycleModule],
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
