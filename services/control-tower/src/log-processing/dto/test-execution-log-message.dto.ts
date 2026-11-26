import {
  IsString,
  IsOptional,
  IsNumber,
  Matches,
  IsObject,
} from 'class-validator';

export class TestExecutionLogMessageDto {
  @IsString()
  instanceId!: string;

  // Only Dokkimi's own test agent sends these, so the types aren't listed
  // here too: a second list only drifts from the test agent's
  @IsString()
  @Matches(/^[A-Z][A-Z_]*$/)
  eventType!: string;

  @IsString()
  message!: string;

  @IsOptional()
  @IsNumber()
  stepIndex?: number;

  @IsOptional()
  @IsNumber()
  subActionIndex?: number;

  /** Sub-step index within a UI action's `steps` array (0-based). */
  @IsOptional()
  @IsNumber()
  subStepIndex?: number;

  /**
   * For UI_SUBSTEP_* events, the sub-step kind (visit / click / type /
   * waitFor / extract / screenshot). Redundant with `message` but cheaper
   * to query.
   */
  @IsOptional()
  @IsString()
  actionType?: string;

  /** For UI_SUBSTEP_* events with a DOM target: the CSS selector used. */
  @IsOptional()
  @IsString()
  selector?: string;

  @IsOptional()
  @IsNumber()
  duration?: number;

  @IsOptional()
  @IsString()
  error?: string;

  @IsOptional()
  @IsString()
  errorType?: string;

  @IsOptional()
  @IsObject()
  variables?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  timestamp?: string;
}
