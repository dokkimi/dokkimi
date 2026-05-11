import { Injectable, Logger } from '@nestjs/common';
import { HttpLogMessage } from '../../types/messages';
import { StorageService } from '../storage.service';
import { NamespaceValidationService } from '../namespace-validation/namespace-validation.service';

@Injectable()
export class HttpLogProcessorService {
  private readonly logger = new Logger(HttpLogProcessorService.name);

  constructor(
    private readonly storage: StorageService,
    private readonly namespaceValidation: NamespaceValidationService,
  ) {}

  /**
   * Processes an HTTP log message
   */
  async process(message: HttpLogMessage, instanceId: string): Promise<void> {
    try {
      // Validate instance exists
      const isValid =
        await this.namespaceValidation.validateInstance(instanceId);
      if (!isValid) {
        this.logger.warn(
          `Skipping HTTP log for invalid instance: ${instanceId}`,
        );
        return;
      }

      await this.storage.storeHttpLog(message);
    } catch (error) {
      this.logger.error(`Error processing HTTP log:`, error);
      throw error;
    }
  }
}
