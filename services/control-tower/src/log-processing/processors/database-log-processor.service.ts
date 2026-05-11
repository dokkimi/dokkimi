import { Injectable, Logger } from '@nestjs/common';
import { DatabaseLogMessageDto } from '../dto/database-log-message.dto';
import { StorageService } from '../storage.service';
import { NamespaceValidationService } from '../namespace-validation/namespace-validation.service';

@Injectable()
export class DatabaseLogProcessorService {
  private readonly logger = new Logger(DatabaseLogProcessorService.name);

  constructor(
    private readonly storage: StorageService,
    private readonly namespaceValidation: NamespaceValidationService,
  ) {}

  async process(
    message: DatabaseLogMessageDto,
    instanceId: string,
  ): Promise<void> {
    try {
      const isValid =
        await this.namespaceValidation.validateInstance(instanceId);
      if (!isValid) {
        this.logger.warn(
          `Skipping database log for invalid instance: ${instanceId}`,
        );
        return;
      }

      await this.storage.storeDatabaseLog(message);
    } catch (error) {
      this.logger.error(`Error processing database log:`, error);
      throw error;
    }
  }
}
