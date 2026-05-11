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

export class TestCompletionNotificationDto {
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

  /** When true, only steps present in stepExecutions were executed (debug partial run).
   * TVS skips validation for steps that have no execution record. */
  @IsBoolean()
  @IsOptional()
  partial?: boolean;
}
