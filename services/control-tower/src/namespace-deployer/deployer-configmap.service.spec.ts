import { Test, TestingModule } from '@nestjs/testing';
import { DeployerConfigMapService } from './deployer-configmap.service';
import { KubernetesResourceService } from '../namespace-lifecycle/kubernetes/kubernetes-resource.service';
import { ConfigMapBuilderService } from '../namespace-lifecycle/builders/configmap-builder.service';
import { DeploymentContext } from './deployment-context.types';

describe('DeployerConfigMapService', () => {
  let service: DeployerConfigMapService;

  const mockK8sResource = {
    createOrUpdateConfigMap: jest.fn(),
  };

  const mockConfigMapBuilder = {
    buildInterceptorConfigMap: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeployerConfigMapService,
        {
          provide: KubernetesResourceService,
          useValue: mockK8sResource,
        },
        {
          provide: ConfigMapBuilderService,
          useValue: mockConfigMapBuilder,
        },
      ],
    }).compile();

    service = module.get<DeployerConfigMapService>(DeployerConfigMapService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('buildAndApply', () => {
    const baseCtx: DeploymentContext = {
      runId: 'run-1',
      instanceId: 'inst-1',
      k8sNamespaceName: 'dokkimi-inst-1',
      instanceItemIds: new Map([
        ['api-service', 'item-1'],
        ['users-db', 'item-2'],
      ]),
      definition: {
        name: 'test-def',
        items: [
          {
            name: 'api-service',
            type: 'SERVICE',
            image: 'api:latest',
            port: 8080,
          },
          {
            name: 'users-db',
            type: 'DATABASE',
            database: 'postgres',
          },
        ],
      },
    };

    it('should build and apply configmap with correct items', async () => {
      const fakeConfigMap = { metadata: { name: 'test' } };
      mockConfigMapBuilder.buildInterceptorConfigMap.mockReturnValue(
        fakeConfigMap,
      );

      await service.buildAndApply(baseCtx);

      expect(
        mockConfigMapBuilder.buildInterceptorConfigMap,
      ).toHaveBeenCalledWith(
        'dokkimi-inst-1',
        expect.arrayContaining([
          expect.objectContaining({
            name: 'api-service',
            k8sName: 'api-service',
            id: 'item-1',
          }),
          expect.objectContaining({
            name: 'users-db',
            k8sName: 'users-db',
            id: 'item-2',
          }),
        ]),
        [], // no mocks
        'inst-1',
        undefined, // no test config
        undefined, // no expected IDs
      );

      expect(mockK8sResource.createOrUpdateConfigMap).toHaveBeenCalledWith(
        'dokkimi-inst-1',
        fakeConfigMap,
      );
    });

    it('should format mock items correctly', async () => {
      const ctxWithMocks: DeploymentContext = {
        ...baseCtx,
        instanceItemIds: new Map([['stripe-mock', 'item-3']]),
        definition: {
          name: 'test-def',
          items: [
            {
              name: 'stripe-mock',
              type: 'MOCK',
              mockMethod: 'POST',
              mockOrigin: 'api-service',
              mockTarget: 'api.stripe.com',
              mockPath: '/v1/charges',
              mockDelayMs: 100,
              mockResponseStatus: 200,
              mockResponseHeaders: { 'content-type': 'application/json' },
              mockResponseBody: { id: 'ch_123' },
            },
          ],
        },
      };

      mockConfigMapBuilder.buildInterceptorConfigMap.mockReturnValue({});

      await service.buildAndApply(ctxWithMocks);

      const mocks =
        mockConfigMapBuilder.buildInterceptorConfigMap.mock.calls[0][2];
      expect(mocks).toEqual([
        {
          method: 'POST',
          origin: 'api-service',
          target: 'api.stripe.com',
          path: '/v1/charges',
          delayMS: 100,
          responseStatus: 200,
          responseHeaders: JSON.stringify({
            'content-type': 'application/json',
          }),
          responseBody: JSON.stringify({ id: 'ch_123' }),
        },
      ]);
    });

    it('should build test config when tests exist', async () => {
      const ctxWithTests: DeploymentContext = {
        ...baseCtx,
        definition: {
          ...baseCtx.definition,
          config: { timeoutSeconds: 60 },
          tests: [
            {
              name: 'health check',
              steps: [
                {
                  action: {
                    type: 'httpRequest' as const,
                    method: 'GET',
                    url: 'http://api-service/health',
                  },
                  assertions: [
                    {
                      assertions: [
                        {
                          path: 'response.status',
                          operator: 'eq' as const,
                          value: 200,
                        },
                      ],
                      extract: { token: 'response.body.token' },
                    },
                  ],
                },
              ],
            },
          ],
        },
      };

      mockConfigMapBuilder.buildInterceptorConfigMap.mockReturnValue({});

      await service.buildAndApply(ctxWithTests);

      const testConfig =
        mockConfigMapBuilder.buildInterceptorConfigMap.mock.calls[0][4];
      expect(testConfig).toEqual({
        testRunId: 'inst-1',
        timeoutSeconds: 60,
        executionMode: 'auto',
        tests: [
          expect.objectContaining({
            name: 'health check',
            steps: [
              expect.objectContaining({
                extract: { token: 'response.body.token' },
              }),
            ],
          }),
        ],
      });

      // Assertions should be stripped
      const strippedStep = testConfig.tests[0].steps[0];
      expect(strippedStep.assertions).toBeUndefined();
    });

    it('should exclude mock items from expectedNamespaceItemIds', async () => {
      const ctxMixed: DeploymentContext = {
        runId: 'run-1',
        instanceId: 'inst-1',
        k8sNamespaceName: 'dokkimi-inst-1',
        instanceItemIds: new Map([
          ['api-service', 'item-1'],
          ['stripe-mock', 'item-2'],
        ]),
        definition: {
          name: 'test-def',
          items: [
            {
              name: 'api-service',
              type: 'SERVICE',
              image: 'api:latest',
              port: 8080,
            },
            {
              name: 'stripe-mock',
              type: 'MOCK',
              mockMethod: 'GET',
              mockTarget: '*',
            },
          ],
          tests: [
            {
              name: 'test',
              steps: [{ action: { type: 'wait' as const, durationMs: 100 } }],
            },
          ],
        },
      };

      mockConfigMapBuilder.buildInterceptorConfigMap.mockReturnValue({});

      await service.buildAndApply(ctxMixed);

      const expectedIds =
        mockConfigMapBuilder.buildInterceptorConfigMap.mock.calls[0][5];
      expect(expectedIds).toEqual(['item-1']);
    });

    it('should use default timeout of 300 when config.timeoutSeconds is not set', async () => {
      const ctxNoTimeout: DeploymentContext = {
        ...baseCtx,
        definition: {
          ...baseCtx.definition,
          tests: [
            {
              name: 'test',
              steps: [{ action: { type: 'wait' as const, durationMs: 100 } }],
            },
          ],
        },
      };

      mockConfigMapBuilder.buildInterceptorConfigMap.mockReturnValue({});

      await service.buildAndApply(ctxNoTimeout);

      const testConfig =
        mockConfigMapBuilder.buildInterceptorConfigMap.mock.calls[0][4];
      expect(testConfig.timeoutSeconds).toBe(300);
    });

    it('should pass variables from definition into testConfig', async () => {
      const ctxVars: DeploymentContext = {
        ...baseCtx,
        definition: {
          ...baseCtx.definition,
          variables: { baseUrl: 'http://api', token: 'abc123' },
          tests: [
            {
              name: 'test',
              steps: [{ action: { type: 'wait' as const, durationMs: 100 } }],
            },
          ],
        },
      };

      mockConfigMapBuilder.buildInterceptorConfigMap.mockReturnValue({});

      await service.buildAndApply(ctxVars);

      const testConfig =
        mockConfigMapBuilder.buildInterceptorConfigMap.mock.calls[0][4];
      expect(testConfig.variables).toEqual({
        baseUrl: 'http://api',
        token: 'abc123',
      });
    });

    it('should use default wildcard values for mock fields when not provided', async () => {
      const ctxMinimalMock: DeploymentContext = {
        ...baseCtx,
        instanceItemIds: new Map([['minimal-mock', 'item-3']]),
        definition: {
          name: 'test-def',
          items: [
            {
              name: 'minimal-mock',
              type: 'MOCK',
            },
          ],
        },
      };

      mockConfigMapBuilder.buildInterceptorConfigMap.mockReturnValue({});

      await service.buildAndApply(ctxMinimalMock);

      const mocks =
        mockConfigMapBuilder.buildInterceptorConfigMap.mock.calls[0][2];
      expect(mocks).toEqual([
        {
          method: '*',
          origin: '',
          target: '*',
          path: '*',
          requestBodyContains: undefined,
          requestBodyMatches: undefined,
          delayMS: undefined,
          responseStatus: undefined,
          responseHeaders: undefined,
          responseBody: undefined,
        },
      ]);
    });

    it('should pass string mockResponseBody as-is without JSON.stringify', async () => {
      const ctxStringBody: DeploymentContext = {
        ...baseCtx,
        instanceItemIds: new Map([['text-mock', 'item-3']]),
        definition: {
          name: 'test-def',
          items: [
            {
              name: 'text-mock',
              type: 'MOCK',
              mockResponseBody: 'plain text response',
            },
          ],
        },
      };

      mockConfigMapBuilder.buildInterceptorConfigMap.mockReturnValue({});

      await service.buildAndApply(ctxStringBody);

      const mocks =
        mockConfigMapBuilder.buildInterceptorConfigMap.mock.calls[0][2];
      expect(mocks[0].responseBody).toBe('plain text response');
    });

    it('should pass string mockResponseHeaders as-is without JSON.stringify', async () => {
      const ctxStringHeaders: DeploymentContext = {
        ...baseCtx,
        instanceItemIds: new Map([['header-mock', 'item-3']]),
        definition: {
          name: 'test-def',
          items: [
            {
              name: 'header-mock',
              type: 'MOCK',
              mockResponseHeaders: 'x-custom: value' as unknown as Record<
                string,
                string
              >,
            },
          ],
        },
      };

      mockConfigMapBuilder.buildInterceptorConfigMap.mockReturnValue({});

      await service.buildAndApply(ctxStringHeaders);

      const mocks =
        mockConfigMapBuilder.buildInterceptorConfigMap.mock.calls[0][2];
      expect(mocks[0].responseHeaders).toBe('x-custom: value');
    });

    it('should handle null mockResponseBody and mockResponseHeaders', async () => {
      const ctxNullFields: DeploymentContext = {
        ...baseCtx,
        instanceItemIds: new Map([['null-mock', 'item-3']]),
        definition: {
          name: 'test-def',
          items: [
            {
              name: 'null-mock',
              type: 'MOCK',
              mockResponseBody: null,
              mockResponseHeaders: null,
            },
          ],
        },
      };

      mockConfigMapBuilder.buildInterceptorConfigMap.mockReturnValue({});

      await service.buildAndApply(ctxNullFields);

      const mocks =
        mockConfigMapBuilder.buildInterceptorConfigMap.mock.calls[0][2];
      expect(mocks[0].responseBody).toBeUndefined();
      expect(mocks[0].responseHeaders).toBeUndefined();
    });

    it('should pass mockRequestBodyContains through as requestBodyContains', async () => {
      const ctxBodyMatch: DeploymentContext = {
        ...baseCtx,
        instanceItemIds: new Map([['llm-mock', 'item-3']]),
        definition: {
          name: 'test-def',
          items: [
            {
              name: 'llm-mock',
              type: 'MOCK',
              mockTarget: 'api.openai.com',
              mockPath: '/v1/chat/completions',
              mockMethod: 'POST',
              mockRequestBodyContains: 'classify this ticket',
              mockResponseStatus: 200,
              mockResponseBody: { id: 'mock-1' },
            },
          ],
        },
      };

      mockConfigMapBuilder.buildInterceptorConfigMap.mockReturnValue({});

      await service.buildAndApply(ctxBodyMatch);

      const mocks =
        mockConfigMapBuilder.buildInterceptorConfigMap.mock.calls[0][2];
      expect(mocks[0].requestBodyContains).toBe('classify this ticket');
      expect(mocks[0].requestBodyMatches).toBeUndefined();
    });

    it('should pass mockRequestBodyMatches through as requestBodyMatches', async () => {
      const ctxRegex: DeploymentContext = {
        ...baseCtx,
        instanceItemIds: new Map([['regex-mock', 'item-3']]),
        definition: {
          name: 'test-def',
          items: [
            {
              name: 'regex-mock',
              type: 'MOCK',
              mockTarget: 'api.openai.com',
              mockPath: '/v1/chat/completions',
              mockMethod: 'POST',
              mockRequestBodyMatches: '"name":\\s*"search_database"',
              mockResponseStatus: 200,
            },
          ],
        },
      };

      mockConfigMapBuilder.buildInterceptorConfigMap.mockReturnValue({});

      await service.buildAndApply(ctxRegex);

      const mocks =
        mockConfigMapBuilder.buildInterceptorConfigMap.mock.calls[0][2];
      expect(mocks[0].requestBodyMatches).toBe('"name":\\s*"search_database"');
      expect(mocks[0].requestBodyContains).toBeUndefined();
    });

    it('should treat null body matching fields as undefined', async () => {
      const ctxNull: DeploymentContext = {
        ...baseCtx,
        instanceItemIds: new Map([['null-body-mock', 'item-3']]),
        definition: {
          name: 'test-def',
          items: [
            {
              name: 'null-body-mock',
              type: 'MOCK',
              mockTarget: 'api.example.com',
              mockPath: '/',
              mockRequestBodyContains: null,
              mockRequestBodyMatches: null,
            },
          ],
        },
      };

      mockConfigMapBuilder.buildInterceptorConfigMap.mockReturnValue({});

      await service.buildAndApply(ctxNull);

      const mocks =
        mockConfigMapBuilder.buildInterceptorConfigMap.mock.calls[0][2];
      expect(mocks[0].requestBodyContains).toBeUndefined();
      expect(mocks[0].requestBodyMatches).toBeUndefined();
    });

    it('should sanitize item names with special characters for k8sName', async () => {
      const ctxSpecialName: DeploymentContext = {
        ...baseCtx,
        instanceItemIds: new Map([['My_Service.v2', 'item-1']]),
        definition: {
          name: 'test-def',
          items: [
            {
              name: 'My_Service.v2',
              type: 'SERVICE',
              image: 'svc:latest',
              port: 3000,
            },
          ],
        },
      };

      mockConfigMapBuilder.buildInterceptorConfigMap.mockReturnValue({});

      await service.buildAndApply(ctxSpecialName);

      const items =
        mockConfigMapBuilder.buildInterceptorConfigMap.mock.calls[0][1];
      expect(items[0].k8sName).toBe('my-service-v2');
      expect(items[0].name).toBe('My_Service.v2');
    });

    it('should add chromium to expectedNamespaceItemIds when UI steps exist', async () => {
      const ctxWithUi: DeploymentContext = {
        ...baseCtx,
        definition: {
          ...baseCtx.definition,
          tests: [
            {
              name: 'ui test',
              steps: [
                {
                  action: {
                    type: 'ui' as const,
                    commands: [{ type: 'navigate', url: 'http://app' }],
                  } as unknown as { type: 'wait'; durationMs: number },
                },
              ],
            },
          ],
        },
      };

      mockConfigMapBuilder.buildInterceptorConfigMap.mockReturnValue({});

      await service.buildAndApply(ctxWithUi);

      const expectedIds =
        mockConfigMapBuilder.buildInterceptorConfigMap.mock.calls[0][5];
      expect(expectedIds).toContain('chromium');
    });

    it('should not add chromium when no UI steps exist', async () => {
      const ctxNoUi: DeploymentContext = {
        ...baseCtx,
        definition: {
          ...baseCtx.definition,
          tests: [
            {
              name: 'api test',
              steps: [
                {
                  action: {
                    type: 'httpRequest' as const,
                    method: 'GET',
                    url: 'http://api/health',
                  },
                },
              ],
            },
          ],
        },
      };

      mockConfigMapBuilder.buildInterceptorConfigMap.mockReturnValue({});

      await service.buildAndApply(ctxNoUi);

      const expectedIds =
        mockConfigMapBuilder.buildInterceptorConfigMap.mock.calls[0][5];
      expect(expectedIds).not.toContain('chromium');
    });

    it('should merge step-level and assertion-level extract rules', async () => {
      const ctxMergedExtract: DeploymentContext = {
        ...baseCtx,
        definition: {
          ...baseCtx.definition,
          tests: [
            {
              name: 'extract test',
              steps: [
                {
                  action: {
                    type: 'httpRequest' as const,
                    method: 'GET',
                    url: 'http://api/data',
                  },
                  extract: { stepVar: 'response.body.id' },
                  assertions: [
                    {
                      assertions: [],
                      extract: {
                        assertVar: 'response.body.token',
                      },
                    },
                    {
                      assertions: [],
                      extract: {
                        anotherVar: 'response.body.name',
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      };

      mockConfigMapBuilder.buildInterceptorConfigMap.mockReturnValue({});

      await service.buildAndApply(ctxMergedExtract);

      const testConfig =
        mockConfigMapBuilder.buildInterceptorConfigMap.mock.calls[0][4];
      const step = testConfig.tests[0].steps[0];
      expect(step.extract).toEqual({
        stepVar: 'response.body.id',
        assertVar: 'response.body.token',
        anotherVar: 'response.body.name',
      });
      expect(step.assertions).toBeUndefined();
    });

    it('should omit extract from stripped step when no extract rules exist', async () => {
      const ctxNoExtract: DeploymentContext = {
        ...baseCtx,
        definition: {
          ...baseCtx.definition,
          tests: [
            {
              name: 'no extract test',
              steps: [
                {
                  action: {
                    type: 'httpRequest' as const,
                    method: 'GET',
                    url: 'http://api/data',
                  },
                  assertions: [
                    {
                      assertions: [
                        {
                          path: 'response.status',
                          operator: 'eq' as const,
                          value: 200,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      };

      mockConfigMapBuilder.buildInterceptorConfigMap.mockReturnValue({});

      await service.buildAndApply(ctxNoExtract);

      const testConfig =
        mockConfigMapBuilder.buildInterceptorConfigMap.mock.calls[0][4];
      const step = testConfig.tests[0].steps[0];
      expect(step.extract).toBeUndefined();
      expect(step.assertions).toBeUndefined();
    });

    it('should filter out items with undefined instanceItemIds from expectedNamespaceItemIds', async () => {
      const ctxMissingId: DeploymentContext = {
        ...baseCtx,
        instanceItemIds: new Map([['api-service', 'item-1']]),
        // users-db is in items but NOT in instanceItemIds
        definition: {
          ...baseCtx.definition,
          tests: [
            {
              name: 'test',
              steps: [{ action: { type: 'wait' as const, durationMs: 100 } }],
            },
          ],
        },
      };

      mockConfigMapBuilder.buildInterceptorConfigMap.mockReturnValue({});

      await service.buildAndApply(ctxMissingId);

      const expectedIds =
        mockConfigMapBuilder.buildInterceptorConfigMap.mock.calls[0][5];
      // users-db has no entry in instanceItemIds, so it should be filtered out
      expect(expectedIds).toEqual(['item-1']);
      expect(expectedIds).not.toContain(undefined);
    });
  });
});
