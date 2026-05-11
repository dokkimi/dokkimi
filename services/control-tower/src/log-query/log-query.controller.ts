import {
  Controller,
  Get,
  Query,
  Param,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { LogQueryService } from './log-query.service';
import { UiTimelineService } from '../log-processing/ui-timeline.service';

@Controller('logs')
export class LogQueryController {
  constructor(
    private readonly logQueryService: LogQueryService,
    private readonly uiTimeline: UiTimelineService,
  ) {}

  /**
   * GET /logs/http/instance/:instanceId
   * Gets HTTP logs for a specific instance
   */
  @Get('http/instance/:instanceId')
  async getHttpLogsByInstance(
    @Param('instanceId') instanceId: string,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    return this.logQueryService.getHttpLogs(instanceId, limit, offset);
  }

  /**
   * GET /logs/console/instance/:instanceId
   * Gets console logs for a specific instance
   */
  @Get('console/instance/:instanceId')
  async getConsoleLogsByInstance(
    @Param('instanceId') instanceId: string,
    @Query('instanceItemId') instanceItemId?: string,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    return this.logQueryService.getConsoleLogs(
      instanceId,
      instanceItemId,
      limit,
      offset,
    );
  }

  /**
   * GET /logs/database/instance/:instanceId
   * Gets database query logs for a specific instance
   */
  @Get('database/instance/:instanceId')
  async getDatabaseLogsByInstance(
    @Param('instanceId') instanceId: string,
    @Query('limit', new DefaultValuePipe(500), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    return this.logQueryService.getDatabaseLogs(instanceId, limit, offset);
  }

  /**
   * GET /logs/test-execution/instance/:instanceId
   * Gets test execution logs for a specific instance
   */
  @Get('test-execution/instance/:instanceId')
  async getTestExecutionLogsByInstance(
    @Param('instanceId') instanceId: string,
    @Query('limit', new DefaultValuePipe(1000), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    return this.logQueryService.getTestExecutionLogs(instanceId, limit, offset);
  }

  /**
   * GET /logs/assertion-results/instance/:instanceId
   * Gets assertion results for a specific instance
   */
  @Get('assertion-results/instance/:instanceId')
  async getAssertionResultsByInstance(@Param('instanceId') instanceId: string) {
    return this.logQueryService.getAssertionResults(instanceId);
  }

  /**
   * GET /logs/ui-timeline/instance/:instanceId
   * Correlated UI timeline: one entry per UI sub-step, each with the
   * HTTP/DB/console log events that landed inside that sub-step's window.
   * Consumed by `dokkimi inspect` to render a tree under a UI step.
   */
  @Get('ui-timeline/instance/:instanceId')
  async getUiTimelineByInstance(@Param('instanceId') instanceId: string) {
    return this.uiTimeline.getTimeline(instanceId);
  }

  /**
   * GET /logs/call-tree/instance/:instanceId/step/:stepIndex
   * Returns the call forest (HTTP+DB events with origin/target nesting) for a
   * single test step. Used by `dokkimi inspect` to render a Timeline
   * view for non-UI steps. Each returned node may have nested `children`
   * representing downstream calls the receiving service made.
   */
  @Get('call-tree/instance/:instanceId/step/:stepIndex')
  async getStepCallTree(
    @Param('instanceId') instanceId: string,
    @Param('stepIndex') stepIndex: string,
  ) {
    return this.uiTimeline.getStepCallTree(instanceId, parseInt(stepIndex, 10));
  }
}
