import { Test, TestingModule } from '@nestjs/testing';
import { TestValidationController } from './test-validation.controller';
import { TestValidationService } from '../test-validation.service';
import { TestCompletionNotificationDto } from '../dto/test-completion-notification.dto';

describe('TestValidationController', () => {
  let controller: TestValidationController;

  const mockService = {
    processTestCompletion: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TestValidationController],
      providers: [
        {
          provide: TestValidationService,
          useValue: mockService,
        },
      ],
    }).compile();

    controller = module.get<TestValidationController>(TestValidationController);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('handleTestCompletion', () => {
    const dto: TestCompletionNotificationDto = {
      testRunId: 'instance-123',
      status: 'success',
      message: 'Tests completed successfully',
    };

    it('should accept test completion notification', async () => {
      mockService.processTestCompletion.mockResolvedValue(undefined);

      const result = await controller.handleTestCompletion(dto);

      expect(result).toEqual({
        status: 'accepted',
        message: 'Test completion notification received',
      });

      expect(mockService.processTestCompletion).toHaveBeenCalledWith(
        dto.testRunId,
        dto.status,
        dto.message,
        undefined, // stepExecutions
        undefined, // partial
      );
    });

    it('should handle test failure notification', async () => {
      const failureDto: TestCompletionNotificationDto = {
        testRunId: 'instance-123',
        status: 'failure',
        message: 'Test execution failed',
      };

      mockService.processTestCompletion.mockResolvedValue(undefined);

      const result = await controller.handleTestCompletion(failureDto);

      expect(result).toEqual({
        status: 'accepted',
        message: 'Test completion notification received',
      });

      expect(mockService.processTestCompletion).toHaveBeenCalledWith(
        failureDto.testRunId,
        failureDto.status,
        failureDto.message,
        undefined,
        undefined,
      );
    });

    it('should handle notification without message', async () => {
      const dtoWithoutMessage: TestCompletionNotificationDto = {
        testRunId: 'instance-123',
        status: 'success',
      };

      mockService.processTestCompletion.mockResolvedValue(undefined);

      const result = await controller.handleTestCompletion(dtoWithoutMessage);

      expect(result).toEqual({
        status: 'accepted',
        message: 'Test completion notification received',
      });

      expect(mockService.processTestCompletion).toHaveBeenCalledWith(
        dtoWithoutMessage.testRunId,
        dtoWithoutMessage.status,
        undefined,
        undefined,
        undefined,
      );
    });

    it('should pass stepExecutions and partial when provided', async () => {
      const fullDto: TestCompletionNotificationDto = {
        testRunId: 'instance-123',
        status: 'success',
        message: 'Tests passed',
        stepExecutions: [
          {
            stepIndex: 0,
            startTime: '2026-01-01T00:00:00.000Z',
            endTime: '2026-01-01T00:00:01.000Z',
          },
        ],
        partial: true,
      };

      mockService.processTestCompletion.mockResolvedValue(undefined);

      const result = await controller.handleTestCompletion(fullDto);

      expect(result).toEqual({
        status: 'accepted',
        message: 'Test completion notification received',
      });

      expect(mockService.processTestCompletion).toHaveBeenCalledWith(
        fullDto.testRunId,
        fullDto.status,
        fullDto.message,
        fullDto.stepExecutions,
        fullDto.partial,
      );
    });

    it('should not throw on service error (async processing)', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      mockService.processTestCompletion.mockRejectedValue(
        new Error('Processing error'),
      );

      // Should return 202 immediately, error handled asynchronously
      const result = await controller.handleTestCompletion(dto);

      expect(result).toEqual({
        status: 'accepted',
        message: 'Test completion notification received',
      });

      // Wait a bit for async error handling
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Error processing test completion:',
        expect.any(Error),
      );

      consoleErrorSpy.mockRestore();
    });
  });
});
