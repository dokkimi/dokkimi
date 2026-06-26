-- CreateTable
CREATE TABLE "message_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT,
    "instanceItemId" TEXT,
    "brokerType" TEXT NOT NULL,
    "brokerName" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "body" JSONB,
    "contentType" TEXT,
    "metadata" JSONB,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "message_logs_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "namespace_instances" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_test_execution_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stepIndex" INTEGER,
    "subActionIndex" INTEGER,
    "subStepIndex" INTEGER,
    "actionType" TEXT,
    "selector" TEXT,
    "duration" INTEGER,
    "error" TEXT,
    "errorType" TEXT,
    "variables" JSONB NOT NULL DEFAULT '{}',
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "test_execution_logs_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "namespace_instances" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_test_execution_logs" ("actionType", "duration", "error", "errorType", "eventType", "id", "instanceId", "message", "selector", "stepIndex", "subActionIndex", "subStepIndex", "timestamp", "variables") SELECT "actionType", "duration", "error", "errorType", "eventType", "id", "instanceId", "message", "selector", "stepIndex", "subActionIndex", "subStepIndex", "timestamp", "variables" FROM "test_execution_logs";
DROP TABLE "test_execution_logs";
ALTER TABLE "new_test_execution_logs" RENAME TO "test_execution_logs";
CREATE INDEX "test_execution_logs_instanceId_idx" ON "test_execution_logs"("instanceId");
CREATE INDEX "test_execution_logs_eventType_idx" ON "test_execution_logs"("eventType");
CREATE INDEX "test_execution_logs_timestamp_idx" ON "test_execution_logs"("timestamp");
CREATE INDEX "test_execution_logs_stepIndex_subActionIndex_idx" ON "test_execution_logs"("stepIndex", "subActionIndex");
CREATE INDEX "test_execution_logs_instanceId_timestamp_idx" ON "test_execution_logs"("instanceId", "timestamp");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "message_logs_instanceId_idx" ON "message_logs"("instanceId");

-- CreateIndex
CREATE INDEX "message_logs_instanceItemId_idx" ON "message_logs"("instanceItemId");

-- CreateIndex
CREATE INDEX "message_logs_brokerName_idx" ON "message_logs"("brokerName");

-- CreateIndex
CREATE INDEX "message_logs_timestamp_idx" ON "message_logs"("timestamp");
