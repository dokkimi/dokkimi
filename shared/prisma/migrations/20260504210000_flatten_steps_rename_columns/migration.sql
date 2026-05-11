-- Flatten steps schema: rename groupIndex/requestIndex columns to
-- stepIndex/subActionIndex across all affected tables, and drop
-- columns that no longer exist in the flat-step model.

-- ============================================================
-- TestExecutionLog: groupIndex → stepIndex, requestIndex → subActionIndex
-- ============================================================
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
INSERT INTO "new_test_execution_logs" ("id", "instanceId", "eventType", "message", "stepIndex", "subActionIndex", "subStepIndex", "actionType", "selector", "duration", "error", "errorType", "variables", "timestamp")
SELECT "id", "instanceId", "eventType", "message", "groupIndex", "requestIndex", "subStepIndex", "actionType", "selector", "duration", "error", "errorType", "variables", "timestamp" FROM "test_execution_logs";
DROP TABLE "test_execution_logs";
ALTER TABLE "new_test_execution_logs" RENAME TO "test_execution_logs";

CREATE INDEX "test_execution_logs_instanceId_idx" ON "test_execution_logs"("instanceId");
CREATE INDEX "test_execution_logs_eventType_idx" ON "test_execution_logs"("eventType");
CREATE INDEX "test_execution_logs_timestamp_idx" ON "test_execution_logs"("timestamp");
CREATE INDEX "test_execution_logs_stepIndex_subActionIndex_idx" ON "test_execution_logs"("stepIndex", "subActionIndex");
CREATE INDEX "test_execution_logs_instanceId_timestamp_idx" ON "test_execution_logs"("instanceId", "timestamp");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- ============================================================
-- AssertionResult: groupIndex → stepIndex, drop requestIndex
-- ============================================================
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_assertion_results" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "requestId" TEXT,
    "stepIndex" INTEGER NOT NULL,
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
INSERT INTO "new_assertion_results" ("id", "instanceId", "requestId", "stepIndex", "assertionIndex", "assertionType", "passed", "expected", "actual", "error", "path", "operator", "blockIndex", "resultKind", "timestamp")
SELECT "id", "instanceId", "requestId", "groupIndex", "assertionIndex", "assertionType", "passed", "expected", "actual", "error", "path", "operator", "blockIndex", "resultKind", "timestamp" FROM "assertion_results";
DROP TABLE "assertion_results";
ALTER TABLE "new_assertion_results" RENAME TO "assertion_results";

CREATE INDEX "assertion_results_instanceId_idx" ON "assertion_results"("instanceId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- ============================================================
-- Artifact: drop groupIndex (stepIndex already exists and keeps
-- its meaning; it was the inner index in the old nested model,
-- now it's the flat sequential index).
-- ============================================================
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_artifacts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "subStepIndex" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT,
    "uri" TEXT NOT NULL,
    "verdict" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "artifacts_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "namespace_instances" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_artifacts" ("id", "instanceId", "stepIndex", "subStepIndex", "type", "name", "uri", "verdict", "createdAt")
SELECT "id", "instanceId", "stepIndex", "subStepIndex", "type", "name", "uri", "verdict", "createdAt" FROM "artifacts";
DROP TABLE "artifacts";
ALTER TABLE "new_artifacts" RENAME TO "artifacts";

CREATE INDEX "artifacts_instanceId_idx" ON "artifacts"("instanceId");
CREATE INDEX "artifacts_instanceId_type_idx" ON "artifacts"("instanceId", "type");
CREATE INDEX "artifacts_instanceId_verdict_idx" ON "artifacts"("instanceId", "verdict");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
