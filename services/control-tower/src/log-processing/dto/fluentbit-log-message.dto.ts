import { IsString, IsOptional } from 'class-validator';

/**
 * DTO for Fluent Bit console log messages
 * Fluent Bit sends: { log, stream, time, instanceId, instanceItemId }
 */
export class FluentBitLogMessageDto {
  @IsString()
  log!: string; // The actual log line from container stdout/stderr

  @IsOptional()
  @IsString()
  stream?: string; // stdout or stderr

  @IsOptional()
  @IsString()
  time?: string; // Timestamp from Fluent Bit

  @IsString()
  instanceId!: string; // Added by record_modifier filter

  @IsOptional()
  @IsString()
  instanceItemId?: string; // Added by record_modifier filter
}
