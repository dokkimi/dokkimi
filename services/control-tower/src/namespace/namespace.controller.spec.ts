// Mock NamespaceLifecycleService before imports
jest.mock('../namespace-lifecycle/namespace-lifecycle.service', () => ({
  NamespaceLifecycleService: jest.fn().mockImplementation(() => ({
    stopInstance: jest.fn(),
  })),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { NamespaceController } from './namespace.controller';
import { NamespaceInstanceService } from './namespace-instance.service';
import { NamespaceLifecycleService } from '../namespace-lifecycle/namespace-lifecycle.service';

describe('NamespaceController', () => {
  let controller: NamespaceController;

  const mockInstanceService = {
    findAllInstances: jest.fn(),
    findInstance: jest.fn(),
  };

  const mockNamespaceLifecycleService = {
    stopInstance: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [NamespaceController],
      providers: [
        {
          provide: NamespaceInstanceService,
          useValue: mockInstanceService,
        },
        {
          provide: NamespaceLifecycleService,
          useValue: mockNamespaceLifecycleService,
        },
      ],
    }).compile();

    controller = module.get<NamespaceController>(NamespaceController);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('findAllInstances', () => {
    it('should return all instances', async () => {
      const mockInstances = [
        {
          id: 'instance-1',
          status: 'RUNNING',
          items: [],
          testExecutionLogCount: 0,
        },
      ];

      mockInstanceService.findAllInstances.mockResolvedValue(mockInstances);

      const result = await controller.findAllInstances();

      expect(result).toEqual(mockInstances);
      expect(mockInstanceService.findAllInstances).toHaveBeenCalled();
    });
  });

  describe('findInstance', () => {
    it('should return an instance by ID', async () => {
      const mockInstance = {
        id: 'instance-1',
        status: 'RUNNING',
        items: [],
      };

      mockInstanceService.findInstance.mockResolvedValue(mockInstance);

      const result = await controller.findInstance('instance-1');

      expect(result).toEqual(mockInstance);
      expect(mockInstanceService.findInstance).toHaveBeenCalledWith(
        'instance-1',
      );
    });
  });

  describe('stopInstance', () => {
    it('should stop an instance', async () => {
      mockNamespaceLifecycleService.stopInstance.mockResolvedValue(undefined);

      await controller.stopInstance('instance-1');

      expect(mockNamespaceLifecycleService.stopInstance).toHaveBeenCalledWith(
        'instance-1',
      );
    });
  });
});
