import { IsString, IsOptional, IsNumber, IsBoolean } from 'class-validator';

export class HttpLogMessageDto {
  @IsString()
  instanceId!: string;

  @IsOptional()
  @IsString()
  instanceItemId?: string;

  @IsString()
  method!: string;

  @IsString()
  url!: string;

  @IsOptional()
  @IsNumber()
  statusCode?: number;

  @IsOptional()
  requestBody?: unknown;

  @IsOptional()
  responseBody?: unknown;

  @IsOptional()
  requestHeaders?: Record<string, unknown>;

  @IsOptional()
  responseHeaders?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  isMocked?: boolean;

  @IsOptional()
  @IsString()
  timestamp?: string;

  @IsOptional()
  @IsString()
  origin?: string;

  @IsOptional()
  @IsString()
  target?: string;

  @IsOptional()
  @IsString()
  targetId?: string;

  @IsOptional()
  @IsString()
  requestSentAt?: string;

  @IsOptional()
  @IsString()
  responseReceivedAt?: string;
}
