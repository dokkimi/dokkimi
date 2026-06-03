import {
  IsString,
  IsOptional,
  IsNumber,
  IsIn,
  IsObject,
} from 'class-validator';

export class TestExecutionLogMessageDto {
  @IsString()
  instanceId!: string;

  @IsString()
  @IsIn([
    'STARTED',
    'HEALTH_WAIT_STARTED',
    'HEALTH_ITEM_READY',
    'HEALTH_ALL_READY',
    'HEALTH_TIMEOUT',
    'TEST_STARTED',
    'TEST_COMPLETED',
    'TEST_EXECUTION_STARTED',
    'REQUEST_STARTED',
    'REQUEST_COMPLETED',
    'REQUEST_FAILED',
    'DB_QUERY_STARTED',
    'DB_QUERY_COMPLETED',
    'DB_QUERY_FAILED',
    'TEST_FAILED',
    'WAIT_STARTED',
    'WAIT_COMPLETED',
    'STEP_STARTED',
    'STEP_COMPLETED',
    'STEP_FAILED',
    'TEST_EXECUTION_COMPLETED',
    'TVS_NOTIFICATION_SENT',
    'TVS_NOTIFICATION_FAILED',
    'ASSERTION_VALIDATION_STARTED',
    'ASSERTION_PASSED',
    'ASSERTION_FAILED',
    'ASSERTION_VALIDATION_COMPLETE',
    'POD_LOGS',
    // UI sub-step boundary events. Emitted by test-agent's UIStepExecutor
    // on either side of each sub-step (visit / click / type / waitFor /
    // extract / screenshot). Downstream HTTP/DB/console logs landing between
    // consecutive starts can be attributed to the preceding sub-step by
    // timestamp window.
    'UI_SUBSTEP_STARTED',
    'UI_SUBSTEP_COMPLETED',
    'UI_SUBSTEP_FAILED',
  ])
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
  variables?: Record<string, string>;

  @IsOptional()
  @IsString()
  timestamp?: string;
}
