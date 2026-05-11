import {
  IsString,
  IsOptional,
  IsArray,
  IsObject,
  IsNumber,
  IsBase64,
  MaxLength,
  ValidateNested,
  Allow,
} from 'class-validator';
import { Type } from 'class-transformer';

class InitFileDto {
  @IsString()
  filename!: string;

  @IsBase64()
  @MaxLength(10 * 1024 * 1024) // 10MB max base64 content
  content!: string; // base64-encoded file content
}

class DefinitionItemDto {
  @IsString()
  name!: string;

  @IsString()
  type!: 'SERVICE' | 'DATABASE' | 'MOCK';

  @IsOptional()
  @IsString()
  description?: string | null;

  // Service fields
  @IsOptional()
  @IsString()
  image?: string | null;

  @IsOptional()
  @IsNumber()
  port?: number | null;

  @IsOptional()
  @IsNumber()
  debugPort?: number | null;

  @IsOptional()
  @IsString()
  healthCheck?: string | null;

  @IsOptional()
  @IsString()
  uiPath?: string | null;

  @IsOptional()
  @IsString()
  domain?: string | null;

  @IsOptional()
  @IsObject()
  env?: Record<string, string> | null;

  @IsOptional()
  @IsNumber()
  minCpu?: number | null;

  @IsOptional()
  @IsNumber()
  minMemory?: number | null;

  @IsOptional()
  @IsNumber()
  maxCpu?: number | null;

  @IsOptional()
  @IsNumber()
  maxMemory?: number | null;

  @IsOptional()
  @IsString()
  localDevPath?: string | null;

  @IsOptional()
  @IsString()
  mountPath?: string | null;

  // Database fields
  @IsOptional()
  @IsString()
  database?: string | null;

  @IsOptional()
  @IsString()
  version?: string | null;

  @IsOptional()
  @IsString()
  dbName?: string | null;

  @IsOptional()
  @IsString()
  dbUser?: string | null;

  @IsOptional()
  @IsString()
  dbPassword?: string | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InitFileDto)
  initFiles?: InitFileDto[] | null;

  // Mock fields
  @IsOptional()
  @IsString()
  mockMethod?: string | null;

  @IsOptional()
  @IsString()
  mockOrigin?: string | null;

  @IsOptional()
  @IsString()
  mockTarget?: string | null;

  @IsOptional()
  @IsString()
  mockPath?: string | null;

  @IsOptional()
  @IsNumber()
  mockDelayMs?: number | null;

  @IsOptional()
  @IsNumber()
  mockResponseStatus?: number | null;

  @IsOptional()
  @IsString()
  mockRequestBodyContains?: string | null;

  @IsOptional()
  @IsString()
  mockRequestBodyMatches?: string | null;

  @IsOptional()
  @IsObject()
  mockResponseHeaders?: Record<string, string> | null;

  @IsOptional()
  mockResponseBody?: unknown;
}

export class DefinitionDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DefinitionItemDto)
  items!: DefinitionItemDto[];

  @IsOptional()
  @Allow()
  @Type(() => Object)
  tests?: unknown[];

  @IsOptional()
  @IsObject()
  variables?: Record<string, string>;

  @IsOptional()
  @IsObject()
  config?: {
    timeoutSeconds?: number;
    browser?: {
      version?: string;
    };
  };
}

export class SubmitInstanceDto {
  @IsObject()
  @ValidateNested()
  @Type(() => DefinitionDto)
  definition!: DefinitionDto;
}
