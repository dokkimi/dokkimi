import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const SPEC_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'dokkimi-instructions.md',
);

export function loadSpec(): string {
  return fs.readFileSync(SPEC_PATH, 'utf-8');
}
