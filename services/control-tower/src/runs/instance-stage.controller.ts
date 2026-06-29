import {
  Controller,
  Post,
  Param,
  Body,
  BadRequestException,
  HttpException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { NamespaceLifecycleService } from '../namespace-lifecycle/namespace-lifecycle.service';

@Controller('instances')
export class InstanceStageController {
  private readonly logger = new Logger(InstanceStageController.name);

  constructor(private readonly lifecycle: NamespaceLifecycleService) {}

  @Post(':instanceId/run-stage')
  async runStage(
    @Param('instanceId') instanceId: string,
    @Body() body: { stage: number },
  ) {
    if (
      typeof body.stage !== 'number' ||
      !Number.isInteger(body.stage) ||
      body.stage < 0
    ) {
      throw new BadRequestException('stage must be a non-negative integer');
    }

    try {
      await this.lifecycle.deployStage(instanceId, body.stage);
      return { deployed: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to deploy stage ${body.stage} for instance ${instanceId}: ${message}`,
      );
      if (err instanceof HttpException) {
        throw err;
      }
      throw new InternalServerErrorException(message);
    }
  }
}
