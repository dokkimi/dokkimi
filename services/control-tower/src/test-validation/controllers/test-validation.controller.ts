import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { TestValidationService } from '../test-validation.service';
import { TestCompletionNotificationDto } from '../dto/test-completion-notification.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { RunsService } from '../../runs/runs.service';

@Controller('test-complete')
export class TestValidationController {
  private readonly logger = new Logger(TestValidationController.name);

  constructor(
    private readonly testValidationService: TestValidationService,
    private readonly prisma: PrismaService,
    private readonly runsService: RunsService,
  ) {}

  /**
   * POST /test-complete
   * Receives test completion notification from test-agent (Desktop mode)
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async handleTestCompletion(
    @Body() dto: TestCompletionNotificationDto,
  ): Promise<{ status: string; message: string }> {
    this.testValidationService
      .processTestCompletion(
        dto.testRunId,
        dto.status,
        dto.message,
        dto.stepExecutions,
        dto.partial,
      )
      .catch(async (error) => {
        this.logger.error(
          `Error processing test completion for ${dto.testRunId}:`,
          error instanceof Error ? error.stack : String(error),
        );
        try {
          await this.prisma.namespaceInstance.update({
            where: { id: dto.testRunId },
            data: {
              testStatus: 'FAILED',
              testCompletedAt: new Date(),
              errorMessage: `Internal error during validation: ${error instanceof Error ? error.message : String(error)}`,
            },
          });
          await this.runsService.handleValidationComplete(
            dto.testRunId,
            false,
            'Internal validation error',
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
