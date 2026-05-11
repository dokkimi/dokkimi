import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
// Side-effect import: registers Express.Multer namespace augmentation.
// Without it, `Express.Multer.File` is undefined under tsc.
import 'multer';
import { ArtifactsService, ArtifactRow } from './artifacts.service';
import { UploadArtifactDto } from './dto/upload-artifact.dto';

const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024; // 10 MB ceiling per the design doc

@Controller('artifacts')
export class ArtifactsController {
  constructor(private readonly artifacts: ArtifactsService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('payload', {
      limits: { fileSize: MAX_ARTIFACT_BYTES },
    }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: UploadArtifactDto,
  ): Promise<{ id: string; uri: string }> {
    if (!file) {
      throw new BadRequestException(
        'payload file field is required (multipart/form-data)',
      );
    }
    return this.artifacts.persist(body, file.buffer);
  }

  @Get('instance/:instanceId')
  async listForInstance(
    @Param('instanceId') instanceId: string,
  ): Promise<{ artifacts: ArtifactRow[] }> {
    const artifacts = await this.artifacts.listForInstance(instanceId);
    return { artifacts };
  }

  @Get('instance/:instanceId/baselines-pending')
  async listPendingBaselines(
    @Param('instanceId') instanceId: string,
  ): Promise<{ pending: ArtifactRow[] }> {
    const pending = await this.artifacts.listPendingBaselines(instanceId);
    return { pending };
  }

  @Get('run/:runId/has-pending')
  async hasPendingBaselines(
    @Param('runId') runId: string,
  ): Promise<{ hasPending: boolean }> {
    const hasPending = await this.artifacts.hasPendingBaselines(runId);
    return { hasPending };
  }

  @Patch(':id/verdict')
  async updateVerdict(
    @Param('id') id: string,
    @Body() body: { verdict: string },
  ): Promise<{ ok: true }> {
    const allowed = ['approved', 'skipped'];
    if (!allowed.includes(body.verdict)) {
      throw new BadRequestException(
        `verdict must be one of: ${allowed.join(', ')}`,
      );
    }
    await this.artifacts.updateVerdict(id, body.verdict);
    return { ok: true };
  }
}
