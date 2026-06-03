import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

describe('HealthController', () => {
  let controller: HealthController;
  let healthService: jest.Mocked<HealthService>;

  const mockHealthService = {
    getHealthStatus: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthService,
          useValue: mockHealthService,
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
    healthService = module.get(HealthService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getHealth', () => {
    it('should return health status', async () => {
      const mockHealth = {
        status: 'healthy' as const,
        service: 'control-tower',
        timestamp: new Date().toISOString(),
        uptime: 100,
        checks: {
          database: {
            status: 'healthy' as const,
            message: 'Database connection successful',
            latency: 10,
          },
          prisma: {
            status: 'healthy' as const,
            message: 'Prisma client connection successful',
            latency: 5,
          },
        },
      };

      mockHealthService.getHealthStatus.mockResolvedValue(mockHealth);

      const result = await controller.getHealth();

      expect(result).toEqual(mockHealth);
      expect(healthService.getHealthStatus).toHaveBeenCalledTimes(1);
    });
  });
});
