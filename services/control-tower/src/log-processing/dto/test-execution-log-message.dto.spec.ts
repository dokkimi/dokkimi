import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { TestExecutionLogMessageDto } from './test-execution-log-message.dto';

const errors = (eventType: unknown) =>
  validateSync(
    plainToInstance(TestExecutionLogMessageDto, {
      instanceId: 'i',
      eventType,
      message: 'm',
    }),
  );

describe('TestExecutionLogMessageDto', () => {
  it.each(['STEP_WARNING', 'STAGE_DEPLOY_FAILED', 'STEP_COMPLETED'])(
    'accepts %s',
    (eventType) => {
      expect(errors(eventType)).toEqual([]);
    },
  );

  it.each(['step warning', '', 5])('rejects %j', (eventType) => {
    expect(errors(eventType)).not.toEqual([]);
  });
});
