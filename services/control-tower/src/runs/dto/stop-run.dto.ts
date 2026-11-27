import { IsOptional, IsString } from 'class-validator';

export class StopRunDto {
  /** Stop only this run, if it is active. Without it, the active run. */
  @IsOptional()
  @IsString()
  runId?: string;
}
