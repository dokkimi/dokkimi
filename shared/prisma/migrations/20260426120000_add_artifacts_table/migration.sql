-- CreateTable
CREATE TABLE "artifacts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "groupIndex" INTEGER NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "subStepIndex" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT,
    "uri" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "artifacts_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "namespace_instances" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "artifacts_instanceId_idx" ON "artifacts"("instanceId");

-- CreateIndex
CREATE INDEX "artifacts_instanceId_type_idx" ON "artifacts"("instanceId", "type");
