import { Test, TestingModule } from '@nestjs/testing';
import { InstanceItemService } from './instance-item.service';
import { PrismaService } from '../prisma/prisma.service';

describe('InstanceItemService', () => {
  let service: InstanceItemService;

  const mockPrismaService = {
    instanceItem: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InstanceItemService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<InstanceItemService>(InstanceItemService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findInstanceItems', () => {
    it('should return all items for an instance', async () => {
      const mockItems = [
        {
          id: 'item-1',
          instanceId: 'instance-1',
          itemDefinitionName: 'Service 1',
        },
        {
          id: 'item-2',
          instanceId: 'instance-1',
          itemDefinitionName: 'Service 2',
        },
      ];

      mockPrismaService.instanceItem.findMany.mockResolvedValue(mockItems);

      const result = await service.findInstanceItems('instance-1');

      expect(mockPrismaService.instanceItem.findMany).toHaveBeenCalledWith({
        where: { instanceId: 'instance-1' },
      });
      expect(result).toEqual(mockItems);
    });
  });

  describe('updateInstanceItemStatus', () => {
    it('should update instance item status', async () => {
      const mockUpdated = {
        id: 'item-1',
        status: 'RUNNING',
      };

      mockPrismaService.instanceItem.update.mockResolvedValue(mockUpdated);

      const result = await service.updateInstanceItemStatus(
        'item-1',
        'RUNNING',
      );

      expect(mockPrismaService.instanceItem.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: { status: 'RUNNING' },
      });
      expect(result.status).toBe('RUNNING');
    });
  });

  describe('updateInstanceItemReadiness', () => {
    it('should update instance item readiness', async () => {
      const mockUpdated = {
        id: 'item-1',
        readinessStatus: 'READY',
        readinessLastChecked: new Date(),
      };

      mockPrismaService.instanceItem.update.mockResolvedValue(mockUpdated);

      const result = await service.updateInstanceItemReadiness(
        'item-1',
        'READY',
      );

      expect(mockPrismaService.instanceItem.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: {
          readinessStatus: 'READY',
          readinessLastChecked: expect.any(Date),
        },
      });
      expect(result.readinessStatus).toBe('READY');
    });
  });

  describe('updateInstanceItemK8sName', () => {
    it('should update instance item K8s name', async () => {
      const mockUpdated = {
        id: 'item-1',
        k8sName: 'test-service',
      };

      mockPrismaService.instanceItem.update.mockResolvedValue(mockUpdated);

      const result = await service.updateInstanceItemK8sName(
        'item-1',
        'test-service',
      );

      expect(mockPrismaService.instanceItem.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: { k8sName: 'test-service' },
      });
      expect(result.k8sName).toBe('test-service');
    });
  });
});
