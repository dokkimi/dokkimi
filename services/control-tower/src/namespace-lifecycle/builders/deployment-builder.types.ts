import * as k8s from '@kubernetes/client-node';

// Shared FluentBit sidecar resource configuration
export const FLUENT_BIT_RESOURCES: k8s.V1ResourceRequirements = {
  requests: { cpu: '50m', memory: '64Mi' },
  limits: { cpu: '200m', memory: '128Mi' },
};

// Generic item interface for deployment builders
export interface ItemDefinitionLike {
  name: string;
  k8sName: string;
  type: string;
  description?: string | null;
  // Service fields
  image?: string | null;
  port?: number | null;
  debugPort?: number | null;
  healthCheck?: string | null;
  uiPath?: string | null;
  domain?: string | null;
  env?: any;
  minCpu?: number | null;
  minMemory?: number | null;
  maxCpu?: number | null;
  maxMemory?: number | null;
  localDevPath?: string | null;
  mountPath?: string | null;
  // Database fields
  database?: string | null;
  initFiles?: { filename: string }[] | null;
  dbName?: string | null;
  dbUser?: string | null;
  dbPassword?: string | null;
  // Runtime ID (instanceItemId, set during deployment)
  id?: string;
}
