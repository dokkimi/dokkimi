import {
  Controller,
  Get,
  Post,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { NamespaceInstanceService } from './namespace-instance.service';
import { NamespaceLifecycleService } from '../namespace-lifecycle/namespace-lifecycle.service';

@Controller('namespaces')
export class NamespaceController {
  constructor(
    private readonly instanceService: NamespaceInstanceService,
    private readonly namespaceLifecycleService: NamespaceLifecycleService,
  ) {}

  /**
   * GET /namespaces/instances
   * Gets all namespace instances
   */
  @Get('instances')
  async findAllInstances() {
    return this.instanceService.findAllInstances();
  }

  /**
   * GET /namespaces/instances/:instanceId
   * Gets a specific instance by ID
   */
  @Get('instances/:instanceId')
  async findInstance(@Param('instanceId') instanceId: string) {
    return this.instanceService.findInstance(instanceId);
  }

  /**
   * POST /namespaces/instances/:instanceId/stop
   * Stops a specific instance
   */
  @Post('instances/:instanceId/stop')
  @HttpCode(HttpStatus.NO_CONTENT)
  async stopInstance(@Param('instanceId') instanceId: string): Promise<void> {
    await this.namespaceLifecycleService.stopInstance(instanceId);
  }
}
