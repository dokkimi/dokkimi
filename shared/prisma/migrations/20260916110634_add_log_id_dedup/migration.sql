-- AlterTable
ALTER TABLE "http_logs" ADD COLUMN "logId" TEXT;

-- AlterTable
ALTER TABLE "database_logs" ADD COLUMN "logId" TEXT;

-- AlterTable
ALTER TABLE "message_logs" ADD COLUMN "logId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "database_logs_logId_timestamp_key" ON "database_logs"("logId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "http_logs_logId_timestamp_key" ON "http_logs"("logId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "message_logs_logId_timestamp_key" ON "message_logs"("logId", "timestamp");
