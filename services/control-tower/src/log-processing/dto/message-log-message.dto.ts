import { IsString, IsOptional, IsObject } from 'class-validator';

export class MessageLogMessageDto {
  // Delivery-dedup id stamped by the sidecar; persisted so the
  // [logId, timestamp] unique constraint can dedup retried deliveries.
  @IsOptional()
  @IsString()
  logId?: string;

  @IsString()
  instanceId!: string;

  @IsOptional()
  @IsString()
  instanceItemId?: string;

  @IsString()
  brokerType!: string;

  @IsString()
  brokerName!: string;

  @IsString()
  operation!: string;

  @IsOptional()
  body?: unknown;

  @IsOptional()
  @IsString()
  contentType?: string;

  @IsOptional()
  @IsString()
  timestamp?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
