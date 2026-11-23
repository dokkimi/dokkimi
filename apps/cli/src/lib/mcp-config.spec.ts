import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Wrapped so tests can inspect calls and make them fail (fs exports can't be
// spied on directly).
const mockRename = jest.fn();
const mockChown = jest.fn();
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    renameSync: (from: string, to: string) => mockRename(from, to),
    chownSync: (p: string, uid: number, gid: number) => mockChown(p, uid, gid),
  };
});

import { addMcpEntry, getMcpConfigProblem, removeMcpEntry } from './mcp-config';

const ENTRY = { command: 'dokkimi', args: ['mcp'] };
const posixIt = process.platform === 'win32' ? it.skip : it;

let dir: string;
let file: string;

const write = (content: string) => fs.writeFileSync(file, content);
const read = () => JSON.parse(fs.readFileSync(file, 'utf-8'));
const mode = (p: string) => fs.statSync(p).mode & 0o777;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dokkimi-mcp-config-'));
  file = path.join(dir, 'config.json');
  mockRename.mockReset();
  mockChown.mockReset();
  mockRename.mockImplementation(jest.requireActual('fs').renameSync);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const UNUSABLE: [string, string, string][] = [
  [
    'trailing comma',
    '{"keep":1,"mcpServers":{"gh":{"command":"g"},},}',
    'is not valid JSON',
  ],
  ['truncated file', '{"keep":1,"mcpSer', 'is not valid JSON'],
  ['comments', '{\n// note\n"keep":1}', 'is not valid JSON'],
  ['empty file', '', 'is not valid JSON'],
  ['top-level array', '[1]', 'is not a JSON object'],
  ['top-level null', 'null', 'is not a JSON object'],
  ['array mcpServers', '{"mcpServers":[1]}', 'that is not an object'],
  ['string mcpServers', '{"mcpServers":"x"}', 'that is not an object'],
];

describe('addMcpEntry', () => {
  it('creates a missing file and its directory', () => {
    file = path.join(dir, '.cursor', 'mcp.json');
    addMcpEntry(file);
    expect(read()).toEqual({ mcpServers: { dokkimi: ENTRY } });
  });

  it('adds the entry and keeps everything else', () => {
    write('{"keep":{"a":1},"mcpServers":{"gh":{"command":"g"}}}');
    addMcpEntry(file);
    expect(read()).toEqual({
      keep: { a: 1 },
      mcpServers: { gh: { command: 'g' }, dokkimi: ENTRY },
    });
  });

  it.each(['{"keep":1}', '{"keep":1,"mcpServers":null}'])(
    'adds mcpServers when absent: %s',
    (content) => {
      write(content);
      addMcpEntry(file);
      expect(read()).toEqual({ keep: 1, mcpServers: { dokkimi: ENTRY } });
    },
  );

  it('accepts a file with a BOM', () => {
    write('\uFEFF{"keep":1}');
    addMcpEntry(file);
    expect(read()).toEqual({ keep: 1, mcpServers: { dokkimi: ENTRY } });
  });

  it('does not write when an entry exists, even a customized one', () => {
    const content = '{"mcpServers":{"dokkimi":{"command":"/opt/dokkimi"}}}';
    write(content);
    addMcpEntry(file);
    expect(fs.readFileSync(file, 'utf-8')).toBe(content);
    expect(mockRename).not.toHaveBeenCalled();
  });

  it.each(UNUSABLE)('leaves the file untouched: %s', (_name, content, msg) => {
    write(content);
    expect(() => addMcpEntry(file)).toThrow(msg);
    expect(fs.readFileSync(file, 'utf-8')).toBe(content);
  });

  it('does not quote file contents in the error', () => {
    write('{"token":"s3cret",}');
    expect(() => addMcpEntry(file)).toThrow(/^is not valid JSON$/);
  });

  it('leaves the file untouched and cleans up when the rename fails', () => {
    write('{"keep":1}');
    mockRename.mockImplementation(() => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    });
    expect(() => addMcpEntry(file)).toThrow('could not be updated (EBUSY)');
    expect(fs.readFileSync(file, 'utf-8')).toBe('{"keep":1}');
    expect(fs.readdirSync(dir)).toEqual(['config.json']);
  });

  posixIt.each([0o600, 0o644, 0o664])('keeps file mode %o', (fileMode) => {
    write('{"keep":1}');
    fs.chmodSync(file, fileMode);
    addMcpEntry(file);
    expect(read().mcpServers.dokkimi).toEqual(ENTRY);
    expect(mode(file)).toBe(fileMode);
  });

  it('gives the replacement the original owner', () => {
    write('{"keep":1}');
    const { uid, gid } = fs.statSync(file);
    addMcpEntry(file);
    expect(mockChown).toHaveBeenCalledWith(
      expect.stringMatching(/\.tmp$/),
      uid,
      gid,
    );
  });

  it('leaves the file untouched when the owner cannot be kept', () => {
    write('{"keep":1}');
    mockChown.mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    expect(() => addMcpEntry(file)).toThrow('could not be updated (EPERM)');
    expect(fs.readFileSync(file, 'utf-8')).toBe('{"keep":1}');
    expect(fs.readdirSync(dir)).toEqual(['config.json']);
  });

  it('does not treat a read failure as a missing file', () => {
    fs.mkdirSync(file);
    expect(() => addMcpEntry(file)).toThrow('could not be read (EISDIR)');
  });

  it('leaves invalid UTF-8 untouched', () => {
    const bytes = Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]);
    fs.writeFileSync(file, bytes);
    expect(() => addMcpEntry(file)).toThrow('is not valid JSON');
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
  });

  it('leaves a hard-linked file untouched', () => {
    write('{"keep":1}');
    fs.linkSync(file, path.join(dir, 'other.json'));
    expect(() => addMcpEntry(file)).toThrow('(hard-linked file)');
    expect(fs.readFileSync(file, 'utf-8')).toBe('{"keep":1}');
  });

  // root can write to read-only files
  (process.getuid?.() === 0 ? it.skip : it)(
    'leaves a read-only file untouched',
    () => {
      write('{"keep":1}');
      fs.chmodSync(file, 0o444);
      expect(() => addMcpEntry(file)).toThrow('could not be updated');
      expect(fs.readFileSync(file, 'utf-8')).toBe('{"keep":1}');
    },
  );

  posixIt('updates the target of a symlink and keeps the link', () => {
    const target = path.join(dir, 'dotfiles.json');
    fs.writeFileSync(target, '{"keep":1}');
    fs.symlinkSync(target, file);
    addMcpEntry(file);
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, 'utf-8'))).toEqual({
      keep: 1,
      mcpServers: { dokkimi: ENTRY },
    });
  });

  posixIt('does not replace a dangling symlink', () => {
    fs.symlinkSync(path.join(dir, 'missing.json'), file);
    expect(() => addMcpEntry(file)).toThrow('could not be created (EEXIST)');
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
  });
});

describe('removeMcpEntry', () => {
  it('removes only the dokkimi entry', () => {
    write('{"keep":1,"mcpServers":{"gh":{"command":"g"},"dokkimi":{"a":1}}}');
    removeMcpEntry(file);
    expect(read()).toEqual({ keep: 1, mcpServers: { gh: { command: 'g' } } });
  });

  it('does nothing when the file is missing', () => {
    removeMcpEntry(file);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('does not write when there is no entry', () => {
    write('{"keep":1}');
    removeMcpEntry(file);
    expect(fs.readFileSync(file, 'utf-8')).toBe('{"keep":1}');
  });

  it.each(UNUSABLE)('leaves the file untouched: %s', (_name, content, msg) => {
    write(content);
    expect(() => removeMcpEntry(file)).toThrow(msg);
    expect(fs.readFileSync(file, 'utf-8')).toBe(content);
  });
});

describe('getMcpConfigProblem', () => {
  it('returns null when registered', () => {
    addMcpEntry(file);
    expect(getMcpConfigProblem(file)).toBeNull();
  });

  it('reports a missing entry', () => {
    expect(getMcpConfigProblem(file)).toBe(`${file} has no dokkimi entry`);
    write('{"keep":1}');
    expect(getMcpConfigProblem(file)).toBe(`${file} has no dokkimi entry`);
  });

  it('reports an unusable file', () => {
    write('{,}');
    expect(getMcpConfigProblem(file)).toBe(`${file} is not valid JSON`);
  });
});
