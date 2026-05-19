import * as fs from 'fs';
import * as path from 'path';

const SPEC_PATH = path.join(__dirname, '..', 'dokkimi-instructions.md');

export function loadSpec(): string {
  return fs.readFileSync(SPEC_PATH, 'utf-8');
}
