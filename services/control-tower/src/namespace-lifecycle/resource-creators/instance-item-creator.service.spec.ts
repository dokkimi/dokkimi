import { Test, TestingModule } from '@nestjs/testing';
import {
  InstanceItemCreatorService,
  DeployableItem,
} from './instance-item-creator.service';
import { KubernetesResourceService } from '../kubernetes/kubernetes-resource.service';
import { ServiceDeploymentBuilderService } from '../builders/service-deployment-builder.service';
import { DatabaseDeploymentBuilderService } from '../builders/database-deployment-builder.service';
import { DatabaseConfigService } from '../builders/database-config.service';
import * as k8s from '@kubernetes/client-node';

describe('InstanceItemCreatorService', () => {
  let service: InstanceItemCreatorService;

  const mockK8sClient = {
    createDeployment: jest.fn(),
    createService: jest.fn(),
    createOrUpdateConfigMap: jest.fn(),
  };

  const mockServiceDeploymentBuilder = {
    buildServiceDeployment: jest.fn(),
    buildService: jest.fn(),
    buildDnsmasqConfigMapForService: jest.fn(),
  };

  const mockDatabaseDeploymentBuilder = {
    buildDatabaseDeployment: jest.fn(),
    buildDatabaseService: jest.fn(),
  };

  const mockDatabaseConfig = {
    getConfig: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InstanceItemCreatorService,
        {
          provide: KubernetesResourceService,
          useValue: mockK8sClient,
        },
        {
          provide: ServiceDeploymentBuilderService,
          useValue: mockServiceDeploymentBuilder,
        },
        {
          provide: DatabaseDeploymentBuilderService,
          useValue: mockDatabaseDeploymentBuilder,
        },
        {
          provide: DatabaseConfigService,
          useValue: mockDatabaseConfig,
        },
      ],
    }).compile();

    service = module.get<InstanceItemCreatorService>(
      InstanceItemCreatorService,
    );

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createService', () => {
    const serviceItem: DeployableItem = {
      name: 'Test Service',
      k8sName: 'test-service',
      type: 'SERVICE',
      image: 'nginx:latest',
      port: 8080,
      healthCheck: '/health',
    };

    const mockDeployment: k8s.V1Deployment = {
      metadata: {
        name: 'test-service',
        namespace: 'test-namespace',
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: {
            app: 'test-service',
          },
        },
        template: {
          spec: {
            containers: [],
          },
        },
      },
    };

    const mockK8sService: k8s.V1Service = {
      metadata: {
        name: 'test-service',
        namespace: 'test-namespace',
      },
      spec: {
        selector: {
          app: 'test-service',
        },
        ports: [{ port: 8080, targetPort: 8080 }],
      },
    };

    it('should create a service deployment and service', async () => {
      mockServiceDeploymentBuilder.buildServiceDeployment.mockReturnValue(
        mockDeployment,
      );
      mockServiceDeploymentBuilder.buildService.mockReturnValue(mockK8sService);
      mockK8sClient.createDeployment.mockResolvedValue(undefined);
      mockK8sClient.createService.mockResolvedValue(undefined);

      await service.createService(
        'test-namespace',
        'instance-1',
        serviceItem,
        '10.96.0.10',
        'item-1',
      );

      expect(
        mockServiceDeploymentBuilder.buildServiceDeployment,
      ).toHaveBeenCalledWith(
        serviceItem,
        'test-namespace',
        'instance-1',
        '10.96.0.10',
        'item-1',
      );
      expect(mockServiceDeploymentBuilder.buildService).toHaveBeenCalledWith(
        serviceItem,
        'test-namespace',
      );
      expect(mockK8sClient.createDeployment).toHaveBeenCalledWith(
        'test-namespace',
        mockDeployment,
      );
      expect(mockK8sClient.createService).toHaveBeenCalledWith(
        'test-namespace',
        mockK8sService,
      );
    });

    it('should skip service creation if image is not specified', async () => {
      const itemWithoutImage = { ...serviceItem, image: undefined };

      await service.createService(
        'test-namespace',
        'instance-1',
        itemWithoutImage,
        '10.96.0.10',
        'item-1',
      );

      expect(
        mockServiceDeploymentBuilder.buildServiceDeployment,
      ).not.toHaveBeenCalled();
      expect(mockK8sClient.createDeployment).not.toHaveBeenCalled();
    });

    it('should handle errors and rethrow them', async () => {
      const error = new Error('K8s creation failed');
      mockServiceDeploymentBuilder.buildServiceDeployment.mockReturnValue(
        mockDeployment,
      );
      mockServiceDeploymentBuilder.buildService.mockReturnValue(mockK8sService);
      mockK8sClient.createDeployment.mockRejectedValue(error);

      await expect(
        service.createService(
          'test-namespace',
          'instance-1',
          serviceItem,
          '10.96.0.10',
          'item-1',
        ),
      ).rejects.toThrow('K8s creation failed');
    });

    it('should work without instanceItemId', async () => {
      mockServiceDeploymentBuilder.buildServiceDeployment.mockReturnValue(
        mockDeployment,
      );
      mockServiceDeploymentBuilder.buildService.mockReturnValue(mockK8sService);
      mockK8sClient.createDeployment.mockResolvedValue(undefined);
      mockK8sClient.createService.mockResolvedValue(undefined);

      await service.createService(
        'test-namespace',
        'instance-1',
        serviceItem,
        '10.96.0.10',
      );

      expect(
        mockServiceDeploymentBuilder.buildServiceDeployment,
      ).toHaveBeenCalledWith(
        serviceItem,
        'test-namespace',
        'instance-1',
        '10.96.0.10',
        undefined,
      );
    });
  });

  describe('createDatabase', () => {
    const databaseItem: DeployableItem = {
      name: 'Postgres DB',
      k8sName: 'postgres-db',
      type: 'DATABASE',
      database: 'postgres',
      initFiles: [
        { filename: 'init.sql', content: Buffer.from('CREATE TABLE test;') },
      ],
    };

    const mockDbConfig = {
      image: 'postgres:15',
      environment: {
        POSTGRES_DB: 'dokkimi',
        POSTGRES_USER: 'dokkimi',
      },
      ports: [5432],
      volumeMounts: [],
      volumes: [],
    };

    const mockDeployment: k8s.V1Deployment = {
      metadata: {
        name: 'postgres-db',
        namespace: 'test-namespace',
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: {
            app: 'postgres-db',
          },
        },
        template: {
          spec: {
            containers: [],
          },
        },
      },
    };

    const mockK8sService: k8s.V1Service = {
      metadata: {
        name: 'postgres-db',
        namespace: 'test-namespace',
      },
      spec: {
        selector: {
          app: 'postgres-db',
        },
        ports: [{ port: 5432, targetPort: 5432 }],
      },
    };

    it('should create a database deployment and service', async () => {
      mockDatabaseConfig.getConfig.mockReturnValue(mockDbConfig);
      mockDatabaseDeploymentBuilder.buildDatabaseDeployment.mockReturnValue(
        mockDeployment,
      );
      mockDatabaseDeploymentBuilder.buildDatabaseService.mockReturnValue(
        mockK8sService,
      );
      mockK8sClient.createDeployment.mockResolvedValue(undefined);
      mockK8sClient.createService.mockResolvedValue(undefined);

      await service.createDatabase(
        'test-namespace',
        'instance-1',
        databaseItem,
        'item-1',
      );

      expect(mockDatabaseConfig.getConfig).toHaveBeenCalledWith(
        'postgres',
        {
          dbName: undefined,
          dbUser: undefined,
          dbPassword: undefined,
        },
        undefined,
      );
      expect(
        mockDatabaseDeploymentBuilder.buildDatabaseDeployment,
      ).toHaveBeenCalledWith(
        databaseItem,
        'test-namespace',
        'instance-1',
        'item-1',
        mockDbConfig,
      );
      expect(
        mockDatabaseDeploymentBuilder.buildDatabaseService,
      ).toHaveBeenCalledWith(databaseItem, 'test-namespace', [5432]);
      expect(mockK8sClient.createDeployment).toHaveBeenCalledWith(
        'test-namespace',
        mockDeployment,
      );
      expect(mockK8sClient.createService).toHaveBeenCalledWith(
        'test-namespace',
        mockK8sService,
      );
    });

    it('should skip database creation if database type is not specified', async () => {
      const itemWithoutDatabase = { ...databaseItem, database: undefined };

      await service.createDatabase(
        'test-namespace',
        'instance-1',
        itemWithoutDatabase,
        'item-1',
      );

      expect(mockDatabaseConfig.getConfig).not.toHaveBeenCalled();
      expect(mockK8sClient.createDeployment).not.toHaveBeenCalled();
    });

    it('should handle errors and rethrow them', async () => {
      const error = new Error('Database creation failed');
      mockDatabaseConfig.getConfig.mockReturnValue(mockDbConfig);
      mockDatabaseDeploymentBuilder.buildDatabaseDeployment.mockReturnValue(
        mockDeployment,
      );
      mockDatabaseDeploymentBuilder.buildDatabaseService.mockReturnValue(
        mockK8sService,
      );
      mockK8sClient.createDeployment.mockRejectedValue(error);

      await expect(
        service.createDatabase(
          'test-namespace',
          'instance-1',
          databaseItem,
          'item-1',
        ),
      ).rejects.toThrow('Database creation failed');
    });
  });
});
