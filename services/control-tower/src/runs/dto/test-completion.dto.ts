import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  ValidateNested,
  IsNumber,
  IsBoolean,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';

export class StepExecutionDto {
  @IsNumber()
  stepIndex!: number;

  @IsString()
  @IsNotEmpty()
  startTime!: string; // ISO timestamp

  @IsString()
  @IsNotEmpty()
  endTime!: string; // ISO timestamp
}

export class TestCompletionDto {
  @IsString()
  @IsNotEmpty()
  testRunId!: string;

  @IsIn(['success', 'failure'])
  status!: 'success' | 'failure';

  @IsString()
  @IsOptional()
  message?: string;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => StepExecutionDto)
  stepExecutions?: StepExecutionDto[];

  @IsBoolean()
  @IsOptional()
  partial?: boolean;
}
