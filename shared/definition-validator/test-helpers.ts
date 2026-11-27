import { ValidationResult, FileSystem } from './validate-helpers';

export function makeResult(file = '/defs/test.json'): ValidationResult {
  return { file, kind: 'definition', errors: [], warnings: [] };
}

export function makeMockFs(files: Record<string, string> = {}): FileSystem {
  return {
    existsSync: (p: string) => p in files,
    readFileSync: (p: string) => {
      if (!(p in files)) {
        throw new Error(`ENOENT: ${p}`);
      }
      return files[p];
    },
  };
}

/** The smallest valid "tests", for definitions that test something else */
export const ONE_TEST = [
  { name: 't', steps: [{ action: { type: 'wait', durationMs: 1 } }] },
];
