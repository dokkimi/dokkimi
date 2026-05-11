import { IsString, IsOptional, IsIn } from 'class-validator';

export class ConsoleLogMessageDto {
  @IsString()
  instanceId!: string;

  @IsOptional()
  @IsString()
  instanceItemId?: string;

  @IsString()
  @IsIn(['INFO', 'WARN', 'ERROR', 'DEBUG'])
  level!: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

  @IsString()
  message!: string;

  @IsOptional()
  @IsString()
  timestamp?: string;
}
