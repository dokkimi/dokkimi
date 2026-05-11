/*
  Warnings:

  - You are about to drop the `image_registry_secrets` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `init_files` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `item_definition_init_files` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `item_definitions` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `namespace_definitions` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `projects` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `users` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the column `localDevPath` on the `instance_items` table. All the data in the column will be lost.
  - You are about to drop the column `mountPath` on the `instance_items` table. All the data in the column will be lost.
  - You are about to drop the column `currentTestRunId` on the `namespace_instances` table. All the data in the column will be lost.
  - You are about to drop the column `debugMode` on the `namespace_instances` table. All the data in the column will be lost.
  - You are about to drop the column `definitionId` on the `namespace_instances` table. All the data in the column will be lost.
  - You are about to drop the column `runMode` on the `namespace_instances` table. All the data in the column will be lost.
  - You are about to drop the column `runNumber` on the `namespace_instances` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "image_registry_secrets_projectId_idx";

-- DropIndex
DROP INDEX "image_registry_secrets_registryUrl_idx";

-- DropIndex
DROP INDEX "image_registry_secrets_registryType_idx";

-- DropIndex
DROP INDEX "image_registry_secrets_name_idx";

-- DropIndex
DROP INDEX "init_files_projectId_idx";

-- DropIndex
DROP INDEX "init_files_dbType_idx";

-- DropIndex
DROP INDEX "init_files_previewNamespaceId_key";

-- DropIndex
DROP INDEX "init_files_filename_key";

-- DropIndex
DROP INDEX "item_definition_init_files_itemDefinitionId_idx";

-- DropIndex
DROP INDEX "item_definitions_projectId_idx";

-- DropIndex
DROP INDEX "item_definitions_isTemplate_idx";

-- DropIndex
DROP INDEX "item_definitions_definitionId_idx";

-- DropIndex
DROP INDEX "item_definitions_name_idx";

-- DropIndex
DROP INDEX "item_definitions_type_idx";

-- DropIndex
DROP INDEX "namespace_definitions_projectId_idx";

-- DropIndex
DROP INDEX "namespace_definitions_name_idx";

-- DropIndex
DROP INDEX "projects_name_key";

-- DropIndex
DROP INDEX "users_email_key";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "image_registry_secrets";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "init_files";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "item_definition_init_files";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "item_definitions";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "namespace_definitions";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "projects";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "users";
PRAGMA foreign_keys=on;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_instance_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "itemDefinitionName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "readinessStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "readinessLastChecked" DATETIME,
    "k8sName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "instance_items_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "namespace_instances" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_instance_items" ("createdAt", "id", "instanceId", "itemDefinitionName", "k8sName", "readinessLastChecked", "readinessStatus", "status", "updatedAt") SELECT "createdAt", "id", "instanceId", "itemDefinitionName", "k8sName", "readinessLastChecked", "readinessStatus", "status", "updatedAt" FROM "instance_items";
DROP TABLE "instance_items";
ALTER TABLE "new_instance_items" RENAME TO "instance_items";
CREATE INDEX "instance_items_instanceId_idx" ON "instance_items"("instanceId");
CREATE INDEX "instance_items_itemDefinitionName_idx" ON "instance_items"("itemDefinitionName");
CREATE INDEX "instance_items_status_idx" ON "instance_items"("status");
CREATE TABLE "new_namespace_instances" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "definitionSnapshot" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "k8sNamespace" TEXT,
    "startedAt" DATETIME,
    "stoppedAt" DATETIME,
    "testStatus" TEXT,
    "testResults" JSONB,
    "testCompletedAt" DATETIME,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "runId" TEXT,
    CONSTRAINT "namespace_instances_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_namespace_instances" ("createdAt", "definitionSnapshot", "errorMessage", "id", "k8sNamespace", "runId", "startedAt", "status", "stoppedAt", "testCompletedAt", "testResults", "testStatus", "updatedAt") SELECT "createdAt", "definitionSnapshot", "errorMessage", "id", "k8sNamespace", "runId", "startedAt", "status", "stoppedAt", "testCompletedAt", "testResults", "testStatus", "updatedAt" FROM "namespace_instances";
DROP TABLE "namespace_instances";
ALTER TABLE "new_namespace_instances" RENAME TO "namespace_instances";
CREATE INDEX "namespace_instances_runId_idx" ON "namespace_instances"("runId");
CREATE INDEX "namespace_instances_status_idx" ON "namespace_instances"("status");
CREATE INDEX "namespace_instances_testStatus_idx" ON "namespace_instances"("testStatus");
CREATE INDEX "namespace_instances_createdAt_idx" ON "namespace_instances"("createdAt");
CREATE TABLE "new_test_execution_logs" (
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
INSERT INTO "new_test_execution_logs" ("duration", "error", "errorType", "eventType", "groupIndex", "id", "instanceId", "message", "requestIndex", "timestamp", "variables") SELECT "duration", "error", "errorType", "eventType", "groupIndex", "id", "instanceId", "message", "requestIndex", "timestamp", "variables" FROM "test_execution_logs";
DROP TABLE "test_execution_logs";
ALTER TABLE "new_test_execution_logs" RENAME TO "test_execution_logs";
CREATE INDEX "test_execution_logs_instanceId_idx" ON "test_execution_logs"("instanceId");
CREATE INDEX "test_execution_logs_eventType_idx" ON "test_execution_logs"("eventType");
CREATE INDEX "test_execution_logs_timestamp_idx" ON "test_execution_logs"("timestamp");
CREATE INDEX "test_execution_logs_groupIndex_requestIndex_idx" ON "test_execution_logs"("groupIndex", "requestIndex");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
