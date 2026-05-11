-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_test_execution_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "groupIndex" INTEGER,
    "requestIndex" INTEGER,
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
INSERT INTO "new_test_execution_logs" ("duration", "error", "errorType", "eventType", "groupIndex", "id", "instanceId", "message", "requestIndex", "timestamp", "variables") SELECT "duration", "error", "errorType", "eventType", "groupIndex", "id", "instanceId", "message", "requestIndex", "timestamp", "variables" FROM "test_execution_logs";
DROP TABLE "test_execution_logs";
ALTER TABLE "new_test_execution_logs" RENAME TO "test_execution_logs";
CREATE INDEX "test_execution_logs_instanceId_idx" ON "test_execution_logs"("instanceId");
CREATE INDEX "test_execution_logs_eventType_idx" ON "test_execution_logs"("eventType");
CREATE INDEX "test_execution_logs_timestamp_idx" ON "test_execution_logs"("timestamp");
CREATE INDEX "test_execution_logs_groupIndex_requestIndex_idx" ON "test_execution_logs"("groupIndex", "requestIndex");
CREATE INDEX "test_execution_logs_instanceId_timestamp_idx" ON "test_execution_logs"("instanceId", "timestamp");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

