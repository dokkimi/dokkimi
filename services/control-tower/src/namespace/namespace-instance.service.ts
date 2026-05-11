import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InstanceStatus } from '@prisma/client';

@Injectable()
export class NamespaceInstanceService {
  private readonly logger = new Logger(NamespaceInstanceService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Gets all namespace instances
   */
  async findAllInstances() {
    const instances = await this.prisma.namespaceInstance.findMany({
      include: {
        items: true,
        _count: {
          select: {
            testExecutionLogs: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return instances.map((instance) => {
      const { _count, ...rest } = instance;
      return {
        ...rest,
        testExecutionLogCount: _count.testExecutionLogs,
      };
    });
  }

  /**
   * Gets a namespace instance by ID
   */
  async findInstance(id: string) {
    const instance = await this.prisma.namespaceInstance.findUnique({
      where: { id },
      include: {
        items: true,
      },
    });

    if (!instance) {
      throw new NotFoundException(`Namespace instance with ID ${id} not found`);
    }

    return instance;
  }

  /**
   * Updates instance status
   */
  async updateInstanceStatus(instanceId: string, status: InstanceStatus) {
    return this.prisma.namespaceInstance.update({
      where: { id: instanceId },
      data: {
        status,
        ...(status === InstanceStatus.RUNNING ? { startedAt: new Date() } : {}),
        ...(status === InstanceStatus.STOPPED ||
        status === InstanceStatus.FAILED
          ? { stoppedAt: new Date() }
          : {}),
      },
    });
  }

  /**
   * Updates instance K8s namespace name
   */
  async updateInstanceK8sNamespace(instanceId: string, k8sNamespace: string) {
    return this.prisma.namespaceInstance.update({
      where: { id: instanceId },
      data: { k8sNamespace },
    });
  }
}
