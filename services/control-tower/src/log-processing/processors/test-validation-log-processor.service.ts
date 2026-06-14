import { Injectable, Logger } from '@nestjs/common';
import { TestValidationLogMessageDto } from '../dto/test-validation-log-message.dto';
import { StorageService } from '../storage.service';
import { NamespaceValidationService } from '../namespace-validation/namespace-validation.service';

@Injectable()
export class TestValidationLogProcessorService {
  private readonly logger = new Logger(TestValidationLogProcessorService.name);

  constructor(
    private readonly storage: StorageService,
    private readonly namespaceValidation: NamespaceValidationService,
  ) {}

  async process(
    message: TestValidationLogMessageDto,
    instanceId: string,
  ): Promise<void> {
    try {
      const isValid =
        await this.namespaceValidation.validateInstance(instanceId);
      if (!isValid) {
        this.logger.warn(
          `Skipping test validation log for invalid instance: ${instanceId}`,
        );
        return;
      }

      await this.storage.storeTestValidationResults(message);
    } catch (error) {
      this.logger.error(`Error processing test validation log:`, error);
      throw error;
    }
  }
}
