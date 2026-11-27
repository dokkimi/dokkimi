import * as fs from 'fs';
import * as path from 'path';
import { isDokkimiDataDir } from '@dokkimi/definition-resolver';

export function getProjectPath(): string | undefined {
  let dir = path.resolve(process.cwd());
  const root = path.parse(dir).root;

  while (dir !== root) {
    const candidate = path.join(dir, '.dokkimi');
    if (
      !isDokkimiDataDir(candidate) &&
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isDirectory()
    ) {
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
