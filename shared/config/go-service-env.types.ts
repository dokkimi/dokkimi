export interface InterceptorEnvVars extends Record<string, string | undefined> {
  // Required
  PORT: string;
  CONTROL_TOWER_URL: string;
  NAMESPACE: string;
  API_KEY: string;
  // Optional
  DNS_IP?: string;
  ORIGIN?: string;
  ORIGIN_DOMAIN?: string;
  LOG_ACTIONS?: string;
  HEALTH_CHECK_ENDPOINT?: string;
  SERVICE_PORT?: string;
  NAMESPACE_ITEM_ID?: string;
  INSTANCE_ITEM_NAME?: string;
  TEST_AGENT_URL?: string;
}

export interface TestAgentEnvVars extends Record<string, string | undefined> {
  PORT: string;
  CONTROL_TOWER_URL: string;
  CONFIG_MAP_NAME?: string;
  INTERCEPTOR_URL?: string;
  // CDP endpoint for the chromium sidecar attached when the definition has
  // UI steps. test-agent fails any `action.type == "ui"` step loudly when this
  // is unset.
  BROWSER_URL?: string;
  DEFAULT_VIEWPORT_WIDTH?: string;
  DEFAULT_VIEWPORT_HEIGHT?: string;
}

export interface BrokerProxyEnvVars extends Record<string, string | undefined> {
  BROKER_TYPE: string;
  BROKER_PORT: string;
  PROXY_PORT: string;
  INSTANCE_ITEM_NAME: string;
  NAMESPACE: string;
  CONTROL_TOWER_URL: string;
  NAMESPACE_ITEM_ID?: string;
  TEST_AGENT_URL?: string;
}

export interface DbProxyEnvVars extends Record<string, string | undefined> {
  DATABASE_TYPE: string;
  DATABASE_PORT: string;
  INSTANCE_ITEM_NAME: string;
  NAMESPACE: string;
  CONTROL_TOWER_URL: string;
  NAMESPACE_ITEM_ID?: string;
  TEST_AGENT_URL?: string;
  QUERY_PORT?: string; // Port for query endpoint (default: 8080)
  DB_USER?: string; // Database user
  DB_PASSWORD?: string; // Database password
  DB_NAME?: string; // Database name
}
