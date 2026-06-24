import { TestDefinition } from '@dokkimi/config';

// ============================================
// DEPLOYMENT CONTEXT
// ============================================

/**
 * The single input to the deployer. Built entirely by the caller.
 *
 * Contains two concerns:
 * 1. What to deploy — a fully resolved definition with init file content
 * 2. Runtime identity — IDs for log correlation and test execution
 */
export interface DeploymentContext {
  runId: string;
  instanceId: string;

  /**
   * Item name -> InstanceItem DB row ID.
   *
   * Used in configmap (urlMap, databaseMap, podNameToNamespaceItemId) and
   * per-pod env vars (INSTANCE_ITEM_ID) so interceptor and db-proxy can
   * attribute traffic/logs to the correct instance item.
   */
  instanceItemIds: Map<string, string>;

  // What to deploy
  definition: DeployableDefinition;
}

// ============================================
// DEPLOYABLE DEFINITION
// ============================================

/**
 * A fully resolved definition. Same shape as what gets written to
 * definition.json on disk, except that initFiles on database items
 * carries actual file content (Buffer) rather than paths.
 */
export interface BrowserConfig {
  version?: string;
}

export interface DefinitionConfig {
  timeoutSeconds?: number;
  browser?: BrowserConfig;
}

export interface DeployableDefinition {
  name: string;
  description?: string | null;
  items: DefinitionItem[];
  tests?: TestDefinition[];
  variables?: Record<string, unknown>;
  config?: DefinitionConfig;
}

// ============================================
// DEFINITION ITEM
// ============================================

/**
 * An item in the resolved definition. All fields from the definition file.
 * Contains no runtime IDs, no container names, no absolute paths — those are
 * computed by the deployer.
 */
export interface DefinitionItem {
  name: string;
  type: 'SERVICE' | 'DATABASE' | 'MOCK';
  description?: string | null;

  // Service fields
  image?: string | null;
  port?: number | null;
  debugPort?: number | null;
  healthCheck?: string | null;
  uiPath?: string | null;
  domain?: string | null;
  env?: Record<string, string> | null;
  minCpu?: number | null;
  minMemory?: number | null;
  maxCpu?: number | null;
  maxMemory?: number | null;
  localDevPath?: string | null;
  mountPath?: string | null;
  command?: string[] | null;

  // Database fields
  database?: string | null;
  version?: string | null;
  dbName?: string | null;
  dbUser?: string | null;
  dbPassword?: string | null;
  initFiles?: DefinitionInitFile[] | null; // array order = execution order

  // Mock fields
  mockMethod?: string | null;
  mockOrigin?: string | null;
  mockTarget?: string | null;
  mockPath?: string | null;
  mockDelayMs?: number | null;
  mockResponseStatus?: number | null;
  mockRequestBodyContains?: string | null;
  mockRequestBodyMatches?: string | null;
  mockResponseHeaders?: Record<string, string> | null;
  mockResponseBody?: unknown;
}

// ============================================
// INIT FILE
// ============================================

/**
 * A database init file with its content.
 * Array position in DefinitionItem.initFiles determines execution order.
 */
export interface DefinitionInitFile {
  filename: string; // original filename (e.g. "schema.sql", "seed_data.sql")
  content: Buffer; // raw file content, ready to write to disk
}
