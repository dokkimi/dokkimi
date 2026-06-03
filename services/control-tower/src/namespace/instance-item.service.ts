import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class InstanceItemService {
  constructor(private prisma: PrismaService) {}

  // ============================================
  // INSTANCE ITEM OPERATIONS
  // ============================================

  /**
   * Gets instance items by instance ID
   */
  async findInstanceItems(instanceId: string) {
    return this.prisma.instanceItem.findMany({
      where: { instanceId },
    });
  }

  /**
   * Updates instance item status
   */
  async updateInstanceItemStatus(
    itemId: string,
    status:
      | 'PENDING'
      | 'STARTING'
      | 'RUNNING'
      | 'STOPPING'
      | 'STOPPED'
      | 'CRASHED',
  ) {
    return this.prisma.instanceItem.update({
      where: { id: itemId },
      data: { status },
    });
  }

  /**
   * Updates instance item readiness
   */
  async updateInstanceItemReadiness(
    itemId: string,
    readinessStatus: 'READY' | 'NOT_READY' | 'UNKNOWN',
  ) {
    return this.prisma.instanceItem.update({
      where: { id: itemId },
      data: {
        readinessStatus,
        readinessLastChecked: new Date(),
      },
    });
  }

  /**
   * Marks all items for an instance as STOPPING with UNKNOWN readiness.
   */
  async markAllStopping(instanceId: string) {
    return this.prisma.instanceItem.updateMany({
      where: { instanceId },
      data: {
        status: 'STOPPING',
        readinessStatus: 'UNKNOWN',
        readinessLastChecked: new Date(),
      },
    });
  }

  /**
   * Updates instance item container name
   */
  async updateInstanceItemContainerName(itemId: string, containerName: string) {
    return this.prisma.instanceItem.update({
      where: { id: itemId },
      data: { containerName },
    });
  }
}
