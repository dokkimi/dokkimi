import {
  IsString,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class AssertionResultDto {
  @IsString()
  path!: string;

  @IsString()
  operator!: string;

  @IsBoolean()
  passed!: boolean;

  @IsOptional()
  expected?: any;

  @IsOptional()
  actual?: any;

  @IsOptional()
  @IsString()
  error?: string;

  @IsNumber()
  blockIndex!: number;

  @IsString()
  resultKind!: string; // "field" | "count" | "extract"
}

export class TestValidationLogMessageDto {
  @IsString()
  instanceId!: string;

  @IsNumber()
  stepIndex!: number;

  @IsBoolean()
  passed!: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AssertionResultDto)
  assertions!: AssertionResultDto[];
}
