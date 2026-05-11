-- AlterTable
ALTER TABLE "artifacts" ADD COLUMN "verdict" TEXT;

-- CreateIndex
CREATE INDEX "artifacts_instanceId_verdict_idx" ON "artifacts"("instanceId", "verdict");
