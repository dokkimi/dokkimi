import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Body,
  Query,
} from '@nestjs/common';
import { RunsService } from './runs.service';
import { CreateRunDto } from './dto/create-run.dto';
import { SubmitInstanceDto } from './dto/submit-instance.dto';
import { RunStorageService } from '../storage/run-storage.service';

@Controller('runs')
export class RunsController {
  constructor(
    private readonly runsService: RunsService,
    private readonly runStorage: RunStorageService,
  ) {}

  /**
   * POST /runs
   * Creates a run with PENDING instance stubs for each definition name.
   * Tears down any existing run first (stops namespaces + cleans DB/storage).
   */
  @Post()
  createRun(@Body() dto: CreateRunDto) {
    return this.runsService.createRun(
      dto.definitions,
      dto.registryCredentials,
      dto.projectPath,
    );
  }

  /**
   * POST /runs/:runId/instances/:instanceId
   * Submits resolved definition content for an instance, triggering deployment.
   */
  @Post(':runId/instances/:instanceId')
  submitInstance(
    @Param('runId') runId: string,
    @Param('instanceId') instanceId: string,
    @Body() dto: SubmitInstanceDto,
  ) {
    return this.runsService.submitInstance(runId, instanceId, dto);
  }

  /**
   * GET /runs/latest
   * Returns the most recent run and all its instances.
   */
  @Get('latest')
  getLatestRun(@Query('projectPath') projectPath?: string) {
    return this.runsService.getLatestRun(projectPath);
  }

  /**
   * GET /runs/:runId/status
   * Returns the status of a run and all its instances.
   */
  @Get(':runId/status')
  getRunStatus(@Param('runId') runId: string) {
    return this.runsService.getRunStatus(runId);
  }

  /**
   * POST /runs/stop
   * Stops the current run. Namespaces are torn down but DB logs and storage
   * files are preserved for post-run analysis.
   */
  @Post('stop')
  stopCurrentRun() {
    return this.runsService.stopCurrentRun();
  }

  /**
   * DELETE /runs/:runId
   * Deletes a run and all its data (instances, logs, storage).
   */
  @Delete(':runId')
  deleteRun(@Param('runId') runId: string) {
    return this.runsService.deleteRun(runId);
  }

  /**
   * GET /runs/:runId/instances/:instanceId/definition
   * Returns the stored definition snapshot for an instance.
   */
  @Get(':runId/instances/:instanceId/definition')
  getInstanceDefinition(@Param('instanceId') instanceId: string) {
    return this.runStorage.readDefinition(instanceId);
  }
}
