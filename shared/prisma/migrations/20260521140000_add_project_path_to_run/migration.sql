-- Add projectPath to runs table for scoping queries by project.

ALTER TABLE "runs" ADD COLUMN "projectPath" TEXT;

CREATE INDEX "runs_projectPath_idx" ON "runs"("projectPath");
