import { Module } from '@nestjs/common';
import { NamespaceValidationService } from './namespace-validation.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [NamespaceValidationService],
  exports: [NamespaceValidationService],
})
export class NamespaceValidationModule {}
