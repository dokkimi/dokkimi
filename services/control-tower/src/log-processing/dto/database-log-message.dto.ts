import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';

export class DatabaseLogMessageDto {
  @IsString()
  instanceId!: string;

  @IsOptional()
  @IsString()
  instanceItemId?: string;

  @IsString()
  @IsIn(['postgresql', 'mysql', 'mongodb', 'postgres', 'mariadb', 'redis'])
  databaseType!: string;

  @IsString()
  databaseName!: string;

  @IsString()
  query!: string;

  @IsOptional()
  params?: Record<string, unknown>;

  @IsBoolean()
  success!: boolean;

  @IsOptional()
  @Type(() => Object)
  data?: unknown[];

  @IsOptional()
  @IsNumber()
  rowsAffected?: number;

  @IsOptional()
  @IsString()
  error?: string;

  @IsOptional()
  @IsNumber()
  duration?: number;

  @IsOptional()
  @IsString()
  timestamp?: string;
}
