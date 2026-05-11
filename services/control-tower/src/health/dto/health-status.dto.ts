import {
  IsString,
  IsBoolean,
  IsOptional,
  IsObject,
  IsNotEmpty,
  IsNumber,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class HealthStatusDetailsDto {
  @IsOptional()
  @IsNumber()
  checkDuration?: number;

  @IsOptional()
  @IsNumber()
  statusCode?: number;

  @IsOptional()
  @IsString()
  error?: string;
}

export class HealthStatusDto {
  @IsString()
  @IsNotEmpty()
  instanceId!: string;

  @IsString()
  @IsNotEmpty()
  instanceItemName!: string; // The config item name in the instance

  @IsString()
  @IsNotEmpty()
  instanceItemId!: string; // The instance item ID

  @IsBoolean()
  ready!: boolean;

  @IsString()
  timestamp!: string; // ISO 8601 format

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => HealthStatusDetailsDto)
  details?: HealthStatusDetailsDto;
}
