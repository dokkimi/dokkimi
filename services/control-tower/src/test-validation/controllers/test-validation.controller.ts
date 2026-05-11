import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { TestValidationService } from '../test-validation.service';
import { TestCompletionNotificationDto } from '../dto/test-completion-notification.dto';

@Controller('test-complete')
export class TestValidationController {
  constructor(private readonly testValidationService: TestValidationService) {}

  /**
   * POST /test-complete
   * Receives test completion notification from test-agent (Desktop mode)
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async handleTestCompletion(
    @Body() dto: TestCompletionNotificationDto,
  ): Promise<{ status: string; message: string }> {
    // Process asynchronously (don't block the response)
    this.testValidationService
      .processTestCompletion(
        dto.testRunId,
        dto.status,
        dto.message,
        dto.stepExecutions,
        dto.partial,
      )
      .catch((error) => {
        // Log error but don't throw (already returned 202)
        console.error('Error processing test completion:', error);
      });

    return {
      status: 'accepted',
      message: 'Test completion notification received',
    };
  }
}
