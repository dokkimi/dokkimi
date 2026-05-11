import { Test, TestingModule } from '@nestjs/testing';
import { LogQueryController } from './log-query.controller';
import { LogQueryService } from './log-query.service';
import { UiTimelineService } from '../log-processing/ui-timeline.service';
import { LogLevel } from '@prisma/client';

describe('LogQueryController', () => {
  let controller: LogQueryController;
  let mockLogQueryService: jest.Mocked<LogQueryService>;
  let mockUiTimelineService: jest.Mocked<UiTimelineService>;

  beforeEach(async () => {
    mockLogQueryService = {
      getHttpLogs: jest.fn(),
      getConsoleLogs: jest.fn(),
      getDatabaseLogs: jest.fn(),
      getTestExecutionLogs: jest.fn(),
      getAssertionResults: jest.fn(),
    } as any;
    mockUiTimelineService = {
      getTimeline: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [LogQueryController],
      providers: [
        {
          provide: LogQueryService,
          useValue: mockLogQueryService,
        },
        {
          provide: UiTimelineService,
          useValue: mockUiTimelineService,
        },
      ],
    }).compile();

    controller = module.get<LogQueryController>(LogQueryController);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getHttpLogsByInstance', () => {
    it('should return HTTP logs for a specific instance', async () => {
      const instanceId = 'instance-1';
      const mockLogs = {
        logs: [
          {
            id: 'log-1',
            instanceId,
            instanceItemId: null,
            method: 'GET',
            url: '/api/test',
            statusCode: 200,
            requestBody: null,
            responseBody: null,
            requestHeaders: null,
            responseHeaders: null,
            origin: null,
            target: null,
            targetId: null,
            isMocked: null,
            requestSentAt: new Date(),
            responseReceivedAt: new Date(),
            timestamp: new Date(),
            duration: 45,
          },
        ],
        total: 1,
        limit: 100,
        offset: 0,
      };

      mockLogQueryService.getHttpLogs.mockResolvedValue(mockLogs);

      const result = await controller.getHttpLogsByInstance(instanceId);

      expect(result).toEqual(mockLogs);
      // When query params are not provided in unit tests, they're undefined
      // (DefaultValuePipe only works in actual HTTP requests)
      expect(mockLogQueryService.getHttpLogs).toHaveBeenCalledWith(
        instanceId,
        undefined,
        undefined,
      );
    });

    it('should use custom limit and offset', async () => {
      const instanceId = 'instance-1';
      const limit = 200;
      const offset = 50;

      const mockLogs = {
        logs: [],
        total: 0,
        limit: 50,
        offset: 10,
      };

      mockLogQueryService.getHttpLogs.mockResolvedValue(mockLogs);

      const result = await controller.getHttpLogsByInstance(
        instanceId,
        limit,
        offset,
      );

      expect(result).toEqual(mockLogs);
      expect(mockLogQueryService.getHttpLogs).toHaveBeenCalledWith(
        instanceId,
        limit,
        offset,
      );
    });
  });

  describe('getConsoleLogsByInstance', () => {
    it('should return console logs for a specific instance', async () => {
      const instanceId = 'instance-1';
      const mockLogs = {
        logs: [
          {
            id: 'log-1',
            instanceId,
            instanceItemId: 'service-1',
            level: LogLevel.INFO,
            message: 'Log message',
            timestamp: new Date(),
          },
        ],
        total: 1,
        limit: 100,
        offset: 0,
      };

      mockLogQueryService.getConsoleLogs.mockResolvedValue(mockLogs);

      const result = await controller.getConsoleLogsByInstance(instanceId);

      expect(result).toEqual(mockLogs);
      // When query params are not provided in unit tests, they're undefined
      // (DefaultValuePipe only works in actual HTTP requests)
      expect(mockLogQueryService.getConsoleLogs).toHaveBeenCalledWith(
        instanceId,
        undefined, // instanceItemId not provided
        undefined, // limit not provided
        undefined, // offset not provided
      );
    });

    it('should use custom limit and offset', async () => {
      const instanceId = 'instance-1';
      const limit = 75;
      const offset = 25;

      const mockLogs = {
        logs: [],
        total: 0,
        limit: 25,
        offset: 5,
      };

      mockLogQueryService.getConsoleLogs.mockResolvedValue(mockLogs);

      const result = await controller.getConsoleLogsByInstance(
        instanceId,
        undefined,
        limit,
        offset,
      );

      expect(result).toEqual(mockLogs);
      expect(mockLogQueryService.getConsoleLogs).toHaveBeenCalledWith(
        instanceId,
        undefined,
        limit,
        offset,
      );
    });

    it('should not filter by instanceItemId when using instance endpoint', async () => {
      const instanceId = 'instance-1';
      const limit = 50;
      const offset = 0;

      const mockLogs = {
        logs: [],
        total: 0,
        limit: 25,
        offset: 5,
      };

      mockLogQueryService.getConsoleLogs.mockResolvedValue(mockLogs);

      await controller.getConsoleLogsByInstance(
        instanceId,
        undefined,
        limit,
        offset,
      );

      expect(mockLogQueryService.getConsoleLogs).toHaveBeenCalledWith(
        instanceId,
        undefined,
        limit,
        offset,
      );
    });
  });

  describe('getUiTimelineByInstance', () => {
    it('delegates to UiTimelineService.getTimeline', async () => {
      const instanceId = 'instance-ui';
      const timeline = [
        {
          stepIndex: 0,
          subStepIndex: 0,
          action: 'click',
          selector: '#submit',
          message: 'click',
          startTimestamp: new Date(),
          endTimestamp: new Date(),
          durationMs: 42,
          status: 'success' as const,
          error: null,
          children: [],
        },
      ];
      mockUiTimelineService.getTimeline.mockResolvedValue(timeline);

      const result = await controller.getUiTimelineByInstance(instanceId);

      expect(mockUiTimelineService.getTimeline).toHaveBeenCalledWith(
        instanceId,
      );
      expect(result).toBe(timeline);
    });
  });
});
