/*
  Warnings:

  - You are about to drop the column `definitionSnapshot` on the `namespace_instances` table. All the data in the column will be lost.
  - Added the required column `name` to the `namespace_instances` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_namespace_instances" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
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
INSERT INTO "new_namespace_instances" ("createdAt", "errorMessage", "id", "k8sNamespace", "runId", "startedAt", "status", "stoppedAt", "testCompletedAt", "testResults", "testStatus", "updatedAt") SELECT "createdAt", "errorMessage", "id", "k8sNamespace", "runId", "startedAt", "status", "stoppedAt", "testCompletedAt", "testResults", "testStatus", "updatedAt" FROM "namespace_instances";
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
