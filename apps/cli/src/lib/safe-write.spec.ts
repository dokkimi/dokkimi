import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createFile } from './safe-write';

const posixIt = process.platform === 'win32' ? it.skip : it;
const mode = (p: string) => fs.statSync(p).mode & 0o777;

describe('createFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dokkimi-safe-write-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // A new CLAUDE.md gets the usual permissions, as before
  posixIt('uses the usual permissions by default', () => {
    const file = path.join(dir, 'CLAUDE.md');
    createFile(file, 'x');
    const umask = process.umask();
    expect(mode(file)).toBe(0o666 & ~umask);
  });

  posixIt('uses the mode given', () => {
    const file = path.join(dir, 'mcp.json');
    createFile(file, '{}', 0o600);
    expect(mode(file)).toBe(0o600);
  });

  it('never overwrites a file', () => {
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, 'mine');
    expect(() => createFile(file, 'x')).toThrow('could not be created');
    expect(fs.readFileSync(file, 'utf-8')).toBe('mine');
  });
});
