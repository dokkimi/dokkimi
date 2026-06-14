import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { RunsService } from './runs.service';
import { TestCompletionDto } from './dto/test-completion.dto';

@Controller('test-complete')
export class TestCompletionController {
  private readonly logger = new Logger(TestCompletionController.name);

  constructor(private readonly runsService: RunsService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async handleTestCompletion(
    @Body() dto: TestCompletionDto,
  ): Promise<{ status: string; message: string }> {
    this.runsService
      .handleTestCompletion(
        dto.testRunId,
        dto.status,
        dto.message,
        dto.stepExecutions,
      )
      .catch(async (error) => {
        this.logger.error(
          `Error processing test completion for ${dto.testRunId}:`,
          error instanceof Error ? error.stack : String(error),
        );
        try {
          await this.runsService.handleValidationComplete(
            dto.testRunId,
            false,
            `Internal error during test completion: ${error instanceof Error ? error.message : String(error)}`,
          );
        } catch (fallbackError) {
          this.logger.error(
            `Fallback error handling also failed for ${dto.testRunId}:`,
            fallbackError instanceof Error
              ? fallbackError.stack
              : String(fallbackError),
          );
        }
      });

    return {
      status: 'accepted',
      message: 'Test completion notification received',
    };
  }
}
