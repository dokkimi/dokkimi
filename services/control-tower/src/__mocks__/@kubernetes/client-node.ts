// Mock @kubernetes/client-node for Jest tests
const mockCoreApi = {
  createNamespace: jest.fn(),
  deleteNamespace: jest.fn(),
  createNamespacedService: jest.fn(),
  createNamespacedConfigMap: jest.fn(),
  replaceNamespacedConfigMap: jest.fn(),
  deleteNamespacedConfigMap: jest.fn(),
};

const mockAppsApi = {
  createNamespacedDeployment: jest.fn(),
};

const MockCoreV1Api = jest.fn();
const MockAppsV1Api = jest.fn();

const mockKubeConfigInstance = {
  loadFromDefault: jest.fn(),
  setCurrentContext: jest.fn(),
  makeApiClient: jest.fn((apiType: unknown) => {
    if (apiType === MockCoreV1Api) {
      return mockCoreApi;
    }
    if (apiType === MockAppsV1Api) {
      return mockAppsApi;
    }
    const typeName = (apiType as { name?: string })?.name || '';
    if (typeName.includes('CoreV1Api')) {
      return mockCoreApi;
    }
    if (typeName.includes('AppsV1Api')) {
      return mockAppsApi;
    }
    return {};
  }),
};

const MockKubeConfig = jest.fn(() => mockKubeConfigInstance);

export const KubeConfig = MockKubeConfig;
export const CoreV1Api = MockCoreV1Api;
export const AppsV1Api = MockAppsV1Api;
