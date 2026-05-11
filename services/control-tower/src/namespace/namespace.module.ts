import { Module } from '@nestjs/common';
import { NamespaceInstanceService } from './namespace-instance.service';
import { InstanceItemService } from './instance-item.service';
import { NamespaceController } from './namespace.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { NamespaceLifecycleModule } from '../namespace-lifecycle/namespace-lifecycle.module';

@Module({
  imports: [PrismaModule, NamespaceLifecycleModule],
  controllers: [NamespaceController],
  providers: [NamespaceInstanceService, InstanceItemService],
  exports: [NamespaceInstanceService, InstanceItemService],
})
export class NamespaceModule {}
