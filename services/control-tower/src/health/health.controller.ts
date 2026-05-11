import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { HealthService } from './health.service';
import { HealthStatusDto } from './dto/health-status.dto';

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly healthService: HealthService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async getHealth() {
    return this.healthService.getHealthStatus();
  }

  @SkipThrottle()
  @Post('status')
  async updateHealthStatus(@Body() dto: HealthStatusDto) {
    try {
      await this.healthService.updateReadinessStatus(dto);
      return { success: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to process health status update for ${dto.instanceItemId}: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }
}
