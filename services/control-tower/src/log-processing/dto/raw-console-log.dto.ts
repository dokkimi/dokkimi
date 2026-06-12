import { IsString, IsOptional } from 'class-validator';

/**
 * DTO for raw console log messages ingested from container stdout/stderr.
 * Format: { log, stream, time, instanceId, instanceItemId }
 */
export class RawConsoleLogDto {
  @IsString()
  log!: string; // The actual log line from container stdout/stderr

  @IsOptional()
  @IsString()
  stream?: string; // stdout or stderr

  @IsOptional()
  @IsString()
  time?: string; // Timestamp from Docker

  @IsString()
  instanceId!: string;

  @IsOptional()
  @IsString()
  instanceItemId?: string;
}
