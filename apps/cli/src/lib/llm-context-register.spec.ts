import * as path from 'path';

// ---------------------------------------------------------------------------
// Mocks — must be declared before import so Jest hoists them
// ---------------------------------------------------------------------------

const mockFs: Record<string, string> = {};
const mockExistsSync = jest.fn((p: string) => p in mockFs);
const mockReadFileSync = jest.fn((p: string) => {
  if (p in mockFs) {
    return mockFs[p];
  }
  throw new Error('ENOENT');
});
const mockWriteFileSync = jest.fn(
  (p: string, content: string, _encoding?: string) => {
    mockFs[p] = content;
  },
);
const mockMkdirSync = jest.fn();

jest.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(args[0] as string),
  readFileSync: (...args: unknown[]) => mockReadFileSync(args[0] as string),
  writeFileSync: (...args: unknown[]) =>
    mockWriteFileSync(args[0] as string, args[1] as string, args[2] as string),
  mkdirSync: (...args: unknown[]) =>
    mockMkdirSync(args[0] as string, args[1] as object),
}));

jest.mock('os', () => ({
  homedir: () => '/mock-home',
}));

const mockConfig = { DOKKIMI_VERSION: '1.2.3' };
jest.mock('@dokkimi/config', () => mockConfig);

import { registerLlmContext } from './llm-context-register';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DOKKIMI_DIR = path.join('/mock-home', '.dokkimi');
const INSTRUCTIONS_PATH = path.join(DOKKIMI_DIR, 'dokkimi-instructions.md');
const VERSION_PATH = path.join(DOKKIMI_DIR, '.version');
const CLAUDE_MD_PATH = path.join('/mock-home', '.claude', 'CLAUDE.md');
const CURSOR_PATH = path.join('/mock-home', '.cursor', 'rules', 'dokkimi.md');
const COPILOT_PATH = path.join(
  '/mock-home',
  '.github',
  'copilot-instructions.md',
);

// The source instructions file that readInstructionsSource reads via __dirname
// __dirname at runtime points to the dist/lib dir, so the source is at ../dokkimi-instructions.md
const INSTRUCTIONS_SOURCE = path.resolve(
  __dirname,
  '..',
  'dokkimi-instructions.md',
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clearMockFs(): void {
  for (const key of Object.keys(mockFs)) {
    delete mockFs[key];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerLlmContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearMockFs();
    mockConfig.DOKKIMI_VERSION = '1.2.3';
  });

  it('does nothing when instructions source is missing', () => {
    // No instructions source file in mockFs -> readInstructionsSource returns null
    registerLlmContext();

    // No files should have been written
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('creates all LLM context files on first run (no cached version)', () => {
    // Provide the source instructions
    mockFs[INSTRUCTIONS_SOURCE] = '# Dokkimi Instructions\nTest content';

    registerLlmContext();

    // Should write the instructions file
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      INSTRUCTIONS_PATH,
      expect.stringContaining('Dokkimi Instructions'),
      'utf-8',
    );

    // Should write the version cache
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      VERSION_PATH,
      '1.2.3',
      'utf-8',
    );

    // Should write CLAUDE.md (via upsertSection)
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      CLAUDE_MD_PATH,
      expect.stringContaining('<!-- dokkimi -->'),
      'utf-8',
    );

    // Should write Cursor rules
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      CURSOR_PATH,
      expect.stringContaining('# Dokkimi'),
      'utf-8',
    );

    // Should write Copilot instructions
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      COPILOT_PATH,
      expect.stringContaining('<!-- dokkimi -->'),
      'utf-8',
    );
  });

  it('creates/updates Claude CLAUDE.md with Dokkimi section', () => {
    mockFs[INSTRUCTIONS_SOURCE] = '# Instructions';

    registerLlmContext();

    const claudeCall = mockWriteFileSync.mock.calls.find(
      (c) => c[0] === CLAUDE_MD_PATH,
    );
    expect(claudeCall).toBeDefined();
    const content = claudeCall![1] as string;
    expect(content).toContain('<!-- dokkimi -->');
    expect(content).toContain('# Dokkimi');
    expect(content).toContain('dokkimi-instructions.md');
  });

  it('creates Cursor rules file', () => {
    mockFs[INSTRUCTIONS_SOURCE] = '# Instructions';

    registerLlmContext();

    const cursorCall = mockWriteFileSync.mock.calls.find(
      (c) => c[0] === CURSOR_PATH,
    );
    expect(cursorCall).toBeDefined();
    const content = cursorCall![1] as string;
    expect(content).toContain('# Dokkimi');
  });

  it('creates Copilot instructions file', () => {
    mockFs[INSTRUCTIONS_SOURCE] = '# Instructions';

    registerLlmContext();

    const copilotCall = mockWriteFileSync.mock.calls.find(
      (c) => c[0] === COPILOT_PATH,
    );
    expect(copilotCall).toBeDefined();
    const content = copilotCall![1] as string;
    expect(content).toContain('<!-- dokkimi -->');
    expect(content).toContain('dokkimi-instructions.md');
  });

  it('skips full registration when version matches cache', () => {
    mockFs[INSTRUCTIONS_SOURCE] = '# Instructions';
    mockFs[VERSION_PATH] = '1.2.3';
    // Mark all target files as existing with proper content
    mockFs[INSTRUCTIONS_PATH] = '# existing instructions';
    mockFs[CLAUDE_MD_PATH] =
      'existing\n\n<!-- dokkimi -->\n# Dokkimi\nhint\n<!-- dokkimi -->\n';
    mockFs[CURSOR_PATH] = '# Dokkimi\n\nhint\n';
    mockFs[COPILOT_PATH] =
      '<!-- dokkimi -->\n# Dokkimi\nhint\n<!-- dokkimi -->\n';

    registerLlmContext();

    // Should NOT write the version cache again (version matches)
    const versionWrites = mockWriteFileSync.mock.calls.filter(
      (c) => c[0] === VERSION_PATH,
    );
    expect(versionWrites).toHaveLength(0);
  });

  it('updates when version is newer than cache', () => {
    mockFs[INSTRUCTIONS_SOURCE] = '# Updated Instructions v2';
    mockFs[VERSION_PATH] = '1.0.0';
    mockConfig.DOKKIMI_VERSION = '1.2.3';

    registerLlmContext();

    // Should write updated instructions
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      INSTRUCTIONS_PATH,
      expect.stringContaining('Updated Instructions v2'),
      'utf-8',
    );

    // Should write new version
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      VERSION_PATH,
      '1.2.3',
      'utf-8',
    );

    // Should update all LLM context files (full register)
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      CLAUDE_MD_PATH,
      expect.stringContaining('<!-- dokkimi -->'),
      'utf-8',
    );
  });

  it('ensures missing files are created even when version matches', () => {
    mockFs[INSTRUCTIONS_SOURCE] = '# Instructions';
    mockFs[VERSION_PATH] = '1.2.3'; // Version matches — triggers ensureMissing path

    // Instructions file doesn't exist — should be created
    // Claude MD doesn't exist — should be created
    // Cursor doesn't exist — should be created
    // Copilot doesn't exist — should be created

    registerLlmContext();

    // Should write the missing instructions file
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      INSTRUCTIONS_PATH,
      expect.stringContaining('Instructions'),
      'utf-8',
    );

    // Should write CLAUDE.md
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      CLAUDE_MD_PATH,
      expect.stringContaining('<!-- dokkimi -->'),
      'utf-8',
    );

    // Should write Cursor rules
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      CURSOR_PATH,
      expect.stringContaining('# Dokkimi'),
      'utf-8',
    );

    // Should write Copilot
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      COPILOT_PATH,
      expect.stringContaining('<!-- dokkimi -->'),
      'utf-8',
    );
  });

  it('replaces existing Dokkimi section in Claude CLAUDE.md on full register', () => {
    mockFs[INSTRUCTIONS_SOURCE] = '# Instructions';
    // Existing CLAUDE.md with old Dokkimi section
    mockFs[CLAUDE_MD_PATH] =
      '# My Config\n\n<!-- dokkimi -->\nOLD CONTENT\n<!-- dokkimi -->\n\n# Other';

    registerLlmContext();

    const claudeCall = mockWriteFileSync.mock.calls.find(
      (c) => c[0] === CLAUDE_MD_PATH,
    );
    expect(claudeCall).toBeDefined();
    const content = claudeCall![1] as string;
    // Old content replaced
    expect(content).not.toContain('OLD CONTENT');
    // New Dokkimi section present
    expect(content).toContain('# Dokkimi');
    // Other content preserved
    expect(content).toContain('# My Config');
    expect(content).toContain('# Other');
  });

  it('handles missing home directory gracefully', () => {
    mockFs[INSTRUCTIONS_SOURCE] = '# Instructions';
    // Make mkdirSync throw for the first call
    mockMkdirSync.mockImplementationOnce(() => {
      throw new Error('EACCES');
    });

    // Should not throw — errors are silently caught
    expect(() => registerLlmContext()).not.toThrow();
  });
});
