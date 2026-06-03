import * as fs from 'fs';
import * as path from 'path';

export function getProjectPath(): string | undefined {
  let dir = path.resolve(process.cwd());
  const root = path.parse(dir).root;

  while (dir !== root) {
    const candidate = path.join(dir, '.dokkimi');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return undefined;
}

export function latestRunUrl(ctUrl: string, projectPath?: string): string {
  if (projectPath) {
    return `${ctUrl}/runs/latest?projectPath=${encodeURIComponent(projectPath)}`;
  }
  return `${ctUrl}/runs/latest`;
}
