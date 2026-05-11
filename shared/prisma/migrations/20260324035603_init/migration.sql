-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "lastAccessedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "namespace_definitions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "projectId" TEXT NOT NULL,
    "tests" JSONB,
    "timeoutSeconds" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "namespace_definitions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "item_definitions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isTemplate" BOOLEAN NOT NULL DEFAULT false,
    "definitionId" TEXT,
    "projectId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "image" TEXT,
    "port" INTEGER,
    "debugPort" INTEGER,
    "healthCheck" TEXT,
    "uiPath" TEXT,
    "env" JSONB,
    "minCpu" REAL,
    "minMemory" REAL,
    "maxCpu" REAL,
    "maxMemory" REAL,
    "imageRegistrySecretId" TEXT,
    "localDevPath" TEXT,
    "mountPath" TEXT,
    "database" TEXT,
    "dbName" TEXT,
    "dbUser" TEXT,
    "dbPassword" TEXT,
    "mockMethod" TEXT,
    "mockOrigin" TEXT,
    "mockTarget" TEXT,
    "mockPath" TEXT,
    "mockDelayMs" INTEGER,
    "mockResponseStatus" INTEGER,
    "mockResponseHeaders" JSONB,
    "mockResponseBody" JSONB,
    "requestMethod" TEXT,
    "requestProtocol" TEXT,
    "requestUrl" TEXT,
    "requestHeaders" JSONB,
    "requestBody" JSONB,
    "requestTarget" TEXT,
    "queryTarget" TEXT,
    "queryText" TEXT,
    "queryParams" JSONB,
    CONSTRAINT "item_definitions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "item_definitions_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "namespace_definitions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "item_definitions_imageRegistrySecretId_fkey" FOREIGN KEY ("imageRegistrySecretId") REFERENCES "image_registry_secrets" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "cancelledAt" DATETIME
);

-- CreateTable
CREATE TABLE "namespace_instances" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "definitionId" TEXT,
    "runNumber" INTEGER,
    "definitionSnapshot" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "k8sNamespace" TEXT,
    "startedAt" DATETIME,
    "stoppedAt" DATETIME,
    "runMode" TEXT,
    "currentTestRunId" TEXT,
    "debugMode" BOOLEAN NOT NULL DEFAULT false,
    "testStatus" TEXT,
    "testResults" JSONB,
    "testCompletedAt" DATETIME,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "runId" TEXT,
    CONSTRAINT "namespace_instances_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "namespace_instances_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "namespace_definitions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "instance_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "itemDefinitionName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "readinessStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "readinessLastChecked" DATETIME,
    "k8sName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "localDevPath" TEXT,
    "mountPath" TEXT,
    CONSTRAINT "instance_items_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "namespace_instances" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "http_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT,
    "instanceItemId" TEXT,
    "method" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "statusCode" INTEGER,
    "requestBody" JSONB,
    "responseBody" JSONB,
    "requestHeaders" JSONB,
    "responseHeaders" JSONB,
    "origin" TEXT,
    "target" TEXT,
    "targetId" TEXT,
    "isMocked" BOOLEAN,
    "requestSentAt" DATETIME,
    "responseReceivedAt" DATETIME,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "http_logs_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "namespace_instances" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "console_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT,
    "instanceItemId" TEXT,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "console_logs_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "namespace_instances" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "database_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT,
    "instanceItemId" TEXT,
    "databaseType" TEXT NOT NULL,
    "databaseName" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "params" JSONB,
    "success" BOOLEAN NOT NULL,
    "data" JSONB,
    "rowsAffected" INTEGER,
    "error" TEXT,
    "duration" INTEGER,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "database_logs_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "namespace_instances" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "test_execution_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "groupIndex" INTEGER,
    "requestIndex" INTEGER,
    "duration" INTEGER,
    "error" TEXT,
    "errorType" TEXT,
    "variables" JSONB NOT NULL DEFAULT '{}',
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "test_execution_logs_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "namespace_instances" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "assertion_results" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "requestId" TEXT,
    "groupIndex" INTEGER NOT NULL,
    "requestIndex" INTEGER NOT NULL,
    "assertionIndex" INTEGER NOT NULL,
    "assertionType" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "expected" JSONB,
    "actual" JSONB,
    "error" TEXT,
    "path" TEXT,
    "operator" TEXT,
    "blockIndex" INTEGER,
    "resultKind" TEXT,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "assertion_results_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "namespace_instances" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "image_registry_secrets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "registryType" TEXT NOT NULL DEFAULT 'OTHER',
    "registryUrl" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "username" TEXT,
    "password" TEXT,
    "awsAccessKeyId" TEXT,
    "awsSecretAccessKey" TEXT,
    "awsRegion" TEXT,
    "azureClientId" TEXT,
    "azureClientSecret" TEXT,
    "azureTenantId" TEXT,
    "googleServiceAccountKey" JSONB,
    "credentials" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "image_registry_secrets_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "init_files" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "filename" TEXT NOT NULL,
    "dbType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "previewNamespaceId" TEXT,
    CONSTRAINT "init_files_previewNamespaceId_fkey" FOREIGN KEY ("previewNamespaceId") REFERENCES "namespace_definitions" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "init_files_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "item_definition_init_files" (
    "itemDefinitionId" TEXT NOT NULL,
    "initFileId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY ("itemDefinitionId", "initFileId"),
    CONSTRAINT "item_definition_init_files_itemDefinitionId_fkey" FOREIGN KEY ("itemDefinitionId") REFERENCES "item_definitions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "item_definition_init_files_initFileId_fkey" FOREIGN KEY ("initFileId") REFERENCES "init_files" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "projects_name_key" ON "projects"("name");

-- CreateIndex
CREATE INDEX "namespace_definitions_name_idx" ON "namespace_definitions"("name");

-- CreateIndex
CREATE INDEX "namespace_definitions_projectId_idx" ON "namespace_definitions"("projectId");

-- CreateIndex
CREATE INDEX "item_definitions_type_idx" ON "item_definitions"("type");

-- CreateIndex
CREATE INDEX "item_definitions_name_idx" ON "item_definitions"("name");

-- CreateIndex
CREATE INDEX "item_definitions_definitionId_idx" ON "item_definitions"("definitionId");

-- CreateIndex
CREATE INDEX "item_definitions_isTemplate_idx" ON "item_definitions"("isTemplate");

-- CreateIndex
CREATE INDEX "item_definitions_projectId_idx" ON "item_definitions"("projectId");

-- CreateIndex
CREATE INDEX "runs_status_idx" ON "runs"("status");

-- CreateIndex
CREATE INDEX "namespace_instances_definitionId_idx" ON "namespace_instances"("definitionId");

-- CreateIndex
CREATE INDEX "namespace_instances_runId_idx" ON "namespace_instances"("runId");

-- CreateIndex
CREATE INDEX "namespace_instances_status_idx" ON "namespace_instances"("status");

-- CreateIndex
CREATE INDEX "namespace_instances_testStatus_idx" ON "namespace_instances"("testStatus");

-- CreateIndex
CREATE INDEX "namespace_instances_createdAt_idx" ON "namespace_instances"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "namespace_instances_definitionId_runNumber_key" ON "namespace_instances"("definitionId", "runNumber");

-- CreateIndex
CREATE INDEX "instance_items_instanceId_idx" ON "instance_items"("instanceId");

-- CreateIndex
CREATE INDEX "instance_items_itemDefinitionName_idx" ON "instance_items"("itemDefinitionName");

-- CreateIndex
CREATE INDEX "instance_items_status_idx" ON "instance_items"("status");

-- CreateIndex
CREATE INDEX "http_logs_instanceId_idx" ON "http_logs"("instanceId");

-- CreateIndex
CREATE INDEX "http_logs_instanceItemId_idx" ON "http_logs"("instanceItemId");

-- CreateIndex
CREATE INDEX "http_logs_timestamp_idx" ON "http_logs"("timestamp");

-- CreateIndex
CREATE INDEX "http_logs_instanceId_timestamp_idx" ON "http_logs"("instanceId", "timestamp");

-- CreateIndex
CREATE INDEX "http_logs_origin_target_idx" ON "http_logs"("origin", "target");

-- CreateIndex
CREATE INDEX "http_logs_isMocked_idx" ON "http_logs"("isMocked");

-- CreateIndex
CREATE INDEX "console_logs_instanceId_idx" ON "console_logs"("instanceId");

-- CreateIndex
CREATE INDEX "console_logs_instanceItemId_idx" ON "console_logs"("instanceItemId");

-- CreateIndex
CREATE INDEX "console_logs_timestamp_idx" ON "console_logs"("timestamp");

-- CreateIndex
CREATE INDEX "console_logs_level_idx" ON "console_logs"("level");

-- CreateIndex
CREATE INDEX "database_logs_instanceId_idx" ON "database_logs"("instanceId");

-- CreateIndex
CREATE INDEX "database_logs_instanceItemId_idx" ON "database_logs"("instanceItemId");

-- CreateIndex
CREATE INDEX "database_logs_databaseName_idx" ON "database_logs"("databaseName");

-- CreateIndex
CREATE INDEX "database_logs_timestamp_idx" ON "database_logs"("timestamp");

-- CreateIndex
CREATE INDEX "database_logs_databaseType_idx" ON "database_logs"("databaseType");

-- CreateIndex
CREATE INDEX "test_execution_logs_instanceId_idx" ON "test_execution_logs"("instanceId");

-- CreateIndex
CREATE INDEX "test_execution_logs_eventType_idx" ON "test_execution_logs"("eventType");

-- CreateIndex
CREATE INDEX "test_execution_logs_timestamp_idx" ON "test_execution_logs"("timestamp");

-- CreateIndex
CREATE INDEX "test_execution_logs_groupIndex_requestIndex_idx" ON "test_execution_logs"("groupIndex", "requestIndex");

-- CreateIndex
CREATE INDEX "assertion_results_instanceId_idx" ON "assertion_results"("instanceId");

-- CreateIndex
CREATE INDEX "image_registry_secrets_name_idx" ON "image_registry_secrets"("name");

-- CreateIndex
CREATE INDEX "image_registry_secrets_registryType_idx" ON "image_registry_secrets"("registryType");

-- CreateIndex
CREATE INDEX "image_registry_secrets_registryUrl_idx" ON "image_registry_secrets"("registryUrl");

-- CreateIndex
CREATE INDEX "image_registry_secrets_projectId_idx" ON "image_registry_secrets"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "init_files_filename_key" ON "init_files"("filename");

-- CreateIndex
CREATE UNIQUE INDEX "init_files_previewNamespaceId_key" ON "init_files"("previewNamespaceId");

-- CreateIndex
CREATE INDEX "init_files_dbType_idx" ON "init_files"("dbType");

-- CreateIndex
CREATE INDEX "init_files_projectId_idx" ON "init_files"("projectId");

-- CreateIndex
CREATE INDEX "item_definition_init_files_itemDefinitionId_idx" ON "item_definition_init_files"("itemDefinitionId");
