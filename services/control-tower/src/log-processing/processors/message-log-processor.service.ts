import { Injectable, Logger } from '@nestjs/common';
import { MessageLogMessageDto } from '../dto/message-log-message.dto';
import { StorageService } from '../storage.service';
import { NamespaceValidationService } from '../namespace-validation/namespace-validation.service';

@Injectable()
export class MessageLogProcessorService {
  private readonly logger = new Logger(MessageLogProcessorService.name);

  constructor(
    private readonly storage: StorageService,
    private readonly namespaceValidation: NamespaceValidationService,
  ) {}

  async process(
    message: MessageLogMessageDto,
    instanceId: string,
  ): Promise<void> {
    try {
      const isValid =
        await this.namespaceValidation.validateInstance(instanceId);
      if (!isValid) {
        this.logger.warn(
          `Skipping message log for invalid instance: ${instanceId}`,
        );
        return;
      }

      await this.storage.storeMessageLog(message);
    } catch (error) {
      this.logger.error(`Error processing message log:`, error);
      throw error;
    }
  }
}
