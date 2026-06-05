-- Add composite index on (projectPath, createdAt) for efficient run history
-- pruning queries: WHERE projectPath = ? ORDER BY createdAt DESC.

CREATE INDEX "runs_projectPath_createdAt_idx" ON "runs"("projectPath", "createdAt");
