import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { NamespaceInstanceService } from './namespace-instance.service';
import { PrismaService } from '../prisma/prisma.service';
import { InstanceStatus } from '@prisma/client';

describe('NamespaceInstanceService', () => {
  let service: NamespaceInstanceService;

  const mockPrismaService = {
    namespaceInstance: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NamespaceInstanceService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<NamespaceInstanceService>(NamespaceInstanceService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findAllInstances', () => {
    it('should return all namespace instances', async () => {
      const mockInstances = [
        {
          id: 'instance-1',
          status: InstanceStatus.RUNNING,
          items: [],
          _count: { testExecutionLogs: 0 },
        },
      ];

      mockPrismaService.namespaceInstance.findMany.mockResolvedValue(
        mockInstances,
      );

      const result = await service.findAllInstances();

      expect(mockPrismaService.namespaceInstance.findMany).toHaveBeenCalledWith(
        {
          include: {
            items: true,
            _count: {
              select: {
                testExecutionLogs: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
      );
      expect(result[0].testExecutionLogCount).toBe(0);
    });
  });

  describe('findInstance', () => {
    const mockInstance = {
      id: 'instance-1',
      status: InstanceStatus.PENDING,
      items: [],
    };

    it('should return an instance by ID', async () => {
      mockPrismaService.namespaceInstance.findUnique.mockResolvedValue(
        mockInstance,
      );

      const result = await service.findInstance('instance-1');

      expect(
        mockPrismaService.namespaceInstance.findUnique,
      ).toHaveBeenCalledWith({
        where: { id: 'instance-1' },
        include: {
          items: true,
        },
      });
      expect(result.id).toBe('instance-1');
      expect(result.status).toBe(InstanceStatus.PENDING);
    });

    it('should throw NotFoundException if instance not found', async () => {
      mockPrismaService.namespaceInstance.findUnique.mockResolvedValue(null);

      await expect(service.findInstance('instance-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateInstanceStatus', () => {
    it('should update instance status to RUNNING', async () => {
      const mockUpdated = {
        id: 'instance-1',
        status: InstanceStatus.RUNNING,
        startedAt: new Date(),
      };

      mockPrismaService.namespaceInstance.update.mockResolvedValue(mockUpdated);

      const result = await service.updateInstanceStatus(
        'instance-1',
        InstanceStatus.RUNNING,
      );

      expect(mockPrismaService.namespaceInstance.update).toHaveBeenCalledWith({
        where: { id: 'instance-1' },
        data: {
          status: InstanceStatus.RUNNING,
          startedAt: expect.any(Date),
        },
      });
      expect(result.status).toBe(InstanceStatus.RUNNING);
    });

    it('should update instance status to STOPPED', async () => {
      const mockUpdated = {
        id: 'instance-1',
        status: InstanceStatus.STOPPED,
        stoppedAt: new Date(),
      };

      mockPrismaService.namespaceInstance.update.mockResolvedValue(mockUpdated);

      const result = await service.updateInstanceStatus(
        'instance-1',
        InstanceStatus.STOPPED,
      );

      expect(mockPrismaService.namespaceInstance.update).toHaveBeenCalledWith({
        where: { id: 'instance-1' },
        data: {
          status: InstanceStatus.STOPPED,
          stoppedAt: expect.any(Date),
        },
      });
      expect(result.status).toBe(InstanceStatus.STOPPED);
    });
  });

  describe('updateInstanceK8sNamespace', () => {
    it('should update instance K8s namespace', async () => {
      const mockUpdated = {
        id: 'instance-1',
        k8sNamespace: 'test-namespace',
      };

      mockPrismaService.namespaceInstance.update.mockResolvedValue(mockUpdated);

      const result = await service.updateInstanceK8sNamespace(
        'instance-1',
        'test-namespace',
      );

      expect(mockPrismaService.namespaceInstance.update).toHaveBeenCalledWith({
        where: { id: 'instance-1' },
        data: { k8sNamespace: 'test-namespace' },
      });
      expect(result.k8sNamespace).toBe('test-namespace');
    });
  });
});
