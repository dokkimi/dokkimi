import { Injectable, Logger } from '@nestjs/common';
import { TestExecutionLogMessageDto } from '../dto/test-execution-log-message.dto';
import { StorageService } from '../storage.service';
import { NamespaceValidationService } from '../namespace-validation/namespace-validation.service';

@Injectable()
export class TestExecutionLogProcessorService {
  private readonly logger = new Logger(TestExecutionLogProcessorService.name);

  constructor(
    private readonly storage: StorageService,
    private readonly namespaceValidation: NamespaceValidationService,
  ) {}

  async process(
    message: TestExecutionLogMessageDto,
    instanceId: string,
  ): Promise<void> {
    try {
      const isValid =
        await this.namespaceValidation.validateInstance(instanceId);
      if (!isValid) {
        this.logger.warn(
          `Skipping test execution log for invalid instance: ${instanceId}`,
        );
        return;
      }

      await this.storage.storeTestExecutionLog(message);
    } catch (error) {
      this.logger.error(`Error processing test execution log:`, error);
      throw error;
    }
  }
}
