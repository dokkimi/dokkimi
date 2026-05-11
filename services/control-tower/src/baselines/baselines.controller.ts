import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import 'multer';
import { RunStorageService } from '../storage/run-storage.service';
import { UploadBaselineDto } from './dto/upload-baseline.dto';

const MAX_BASELINE_BYTES = 10 * 1024 * 1024;

/**
 * POST /baselines — accepts a visual-regression baseline upload from the
 * CLI at run-start. Baselines are inputs (git-tracked) that CT's post-run
 * visualMatch diff job needs to read locally.
 *
 * Distinct from /artifacts (which handles run OUTPUTS). Both use multipart,
 * but baselines have a different lifecycle (input, per-run scoped to disk
 * but originally from .dokkimi/<project>/baselines/) and don't get an
 * Artifact row — they're not the run's output.
 */
@Controller('baselines')
export class BaselinesController {
  constructor(private readonly storage: RunStorageService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('payload', {
      limits: { fileSize: MAX_BASELINE_BYTES },
    }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: UploadBaselineDto,
  ): Promise<{ uri: string }> {
    if (!file || file.size === 0) {
      throw new BadRequestException(
        'payload file field is required (multipart/form-data) and must be non-empty',
      );
    }
    const written = await this.storage.persistBaseline(
      body.instanceId,
      body.name,
      file.buffer,
    );
    return { uri: written.uri };
  }
}
