import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RunStorageService } from '../storage/run-storage.service';
import type {
  ArtifactType,
  UploadArtifactDto,
} from './dto/upload-artifact.dto';

export interface PersistedArtifact {
  id: string;
  uri: string;
}

export interface ArtifactRow {
  id: string;
  instanceId: string;
  stepIndex: number;
  subStepIndex: number;
  type: string;
  name: string | null;
  uri: string;
  createdAt: Date;
}

/**
 * Validates and persists binary artifacts uploaded by test-agent during a run.
 *
 * Type/name pairing rules:
 *   - 'screenshot' — name OPTIONAL: user-named (visualMatch capture, explicit
 *     screenshot primitive) or nameless (debug failure auto-capture).
 *   - 'diff'       — name REQUIRED: only emitted by visualMatch failures, where
 *     the diff inherits the visualMatch's name.
 *   - 'html'       — name FORBIDDEN: only emitted by debug failure auto-capture
 *     paired with the failure screenshot.
 */
@Injectable()
export class ArtifactsService {
  private readonly logger = new Logger(ArtifactsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: RunStorageService,
  ) {}

  async persist(
    dto: UploadArtifactDto,
    payload: Buffer,
  ): Promise<PersistedArtifact> {
    this.assertTypeNamePairing(dto.type, dto.name);
    if (!payload || payload.length === 0) {
      throw new BadRequestException(
        'payload is required and must be non-empty',
      );
    }

    const written = await this.storage.persistArtifact(
      dto.instanceId,
      dto.type,
      payload,
      {
        stepIndex: dto.stepIndex,
        subStepIndex: dto.subStepIndex,
      },
      dto.name ?? null,
      dto.isFailure ?? false,
    );

    const row = await this.prisma.artifact.create({
      data: {
        instanceId: dto.instanceId,
        stepIndex: dto.stepIndex,
        subStepIndex: dto.subStepIndex,
        type: dto.type,
        name: dto.name ?? null,
        uri: written.uri,
      },
      select: { id: true, uri: true },
    });

    this.logger.log(
      `Stored artifact id=${row.id} type=${dto.type} ` +
        `instance=${dto.instanceId} pos=${dto.stepIndex}.${dto.subStepIndex} ` +
        `bytes=${payload.length} uri=${row.uri}`,
    );

    return row;
  }

  async listForInstance(instanceId: string): Promise<ArtifactRow[]> {
    return this.prisma.artifact.findMany({
      where: { instanceId },
      orderBy: [{ stepIndex: 'asc' }, { subStepIndex: 'asc' }, { type: 'asc' }],
    });
  }

  /**
   * Returns visualMatch capture rows that need user attention: verdict
   * 'no-baseline' (first-time captures awaiting approval) or 'fail'
   * (mismatches that may warrant accepting a new baseline). 'pass' captures
   * are excluded since nothing needs to happen.
   */
  async listPendingBaselines(instanceId: string): Promise<ArtifactRow[]> {
    return this.prisma.artifact.findMany({
      where: {
        instanceId,
        type: 'screenshot',
        verdict: { in: ['no-baseline', 'fail'] },
      },
      orderBy: [{ stepIndex: 'asc' }, { subStepIndex: 'asc' }],
    });
  }

  async hasPendingBaselines(runId: string): Promise<boolean> {
    const count = await this.prisma.artifact.count({
      where: {
        instance: { runId },
        type: 'screenshot',
        verdict: { in: ['no-baseline', 'fail'] },
      },
    });
    return count > 0;
  }

  async updateVerdict(id: string, verdict: string): Promise<void> {
    await this.prisma.artifact.update({
      where: { id },
      data: { verdict },
    });
  }

  private assertTypeNamePairing(
    type: ArtifactType,
    name: string | undefined,
  ): void {
    switch (type) {
      case 'screenshot':
        // name is optional — both modes valid.
        return;
      case 'diff':
        if (!name) {
          throw new BadRequestException(
            "type='diff' requires a name (matches the visualMatch baseline)",
          );
        }
        return;
      case 'html':
        if (name) {
          throw new BadRequestException(
            "type='html' must not carry a name — only emitted by debug failure capture",
          );
        }
        return;
    }
  }
}
