import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
} from 'class-validator';

export type ArtifactType = 'screenshot' | 'diff' | 'html';

export const ARTIFACT_TYPES: ArtifactType[] = ['screenshot', 'diff', 'html'];

// Mirrors the validator rule for user-supplied names: alphanumeric + dash + underscore, 1-64 chars.
const ARTIFACT_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Multipart upload payload for POST /artifacts. The actual binary lives on
 * the `payload` file field (handled by FileInterceptor at the controller).
 */
export class UploadArtifactDto {
  @IsString()
  instanceId!: string;

  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(0)
  stepIndex!: number;

  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(0)
  subStepIndex!: number;

  @IsEnum(ARTIFACT_TYPES, {
    message: `type must be one of: ${ARTIFACT_TYPES.join(', ')}`,
  })
  type!: ArtifactType;

  // Optional: required when type is 'screenshot' or 'diff' AND the artifact
  // is user-named (visualMatch capture/diff, explicit screenshot). Null/empty
  // signals a debug failure capture (no user-supplied name).
  @IsOptional()
  @IsString()
  @Length(1, 64)
  @Matches(ARTIFACT_NAME_PATTERN, {
    message:
      'name must match [a-zA-Z0-9_-]{1,64} (alphanumeric, dash, underscore)',
  })
  name?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  isFailure?: boolean;

  @IsOptional()
  @IsString()
  ignoreRegionBounds?: string;
}
