import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getCliVersion } from './version';

const DOKKIMI_DIR = path.join(os.homedir(), '.dokkimi');
const INSTRUCTIONS_PATH = path.join(DOKKIMI_DIR, 'dokkimi-instructions.md');
const VERSION_PATH = path.join(DOKKIMI_DIR, '.version');
const DOKKIMI_MARKER = '<!-- dokkimi -->';

const HINT = `When the user asks about Dokkimi, .dokkimi/ files, or writing test definitions for microservices, read the file ${INSTRUCTIONS_PATH} for the complete Dokkimi reference. Do not guess — that file has the full specification.`;

function readStoredVersion(): string | null {
  try {
    return fs.readFileSync(VERSION_PATH, 'utf-8').trim();
  } catch {
    return null;
  }
}

function writeVersion(version: string): void {
  fs.mkdirSync(DOKKIMI_DIR, { recursive: true });
  fs.writeFileSync(VERSION_PATH, version, 'utf-8');
}

function writeInstructions(content: string): void {
  fs.mkdirSync(DOKKIMI_DIR, { recursive: true });
  fs.writeFileSync(INSTRUCTIONS_PATH, content, 'utf-8');
}

function upsertSection(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const section = `${DOKKIMI_MARKER}\n# Dokkimi\n\n${HINT}\n${DOKKIMI_MARKER}`;
  let content = '';

  try {
    if (fs.existsSync(filePath)) {
      content = fs.readFileSync(filePath, 'utf-8');
    }
  } catch {
    // Start fresh
  }

  if (content.includes(DOKKIMI_MARKER)) {
    const regex = new RegExp(
      `${DOKKIMI_MARKER}[\\s\\S]*?${DOKKIMI_MARKER}`,
      'g',
    );
    content = content.replace(regex, section);
  } else {
    content = content.trimEnd() + '\n\n' + section + '\n';
  }

  fs.writeFileSync(filePath, content, 'utf-8');
}

function hasDokkimiSection(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) {
      return false;
    }
    return fs.readFileSync(filePath, 'utf-8').includes(DOKKIMI_MARKER);
  } catch {
    return false;
  }
}

function readInstructionsSource(): string | null {
  try {
    return fs.readFileSync(
      path.join(__dirname, '..', 'dokkimi-instructions.md'),
      'utf-8',
    );
  } catch {
    return null;
  }
}

/**
 * Full registration: writes all LLM context files unconditionally.
 * Used on first launch or when the app version changes.
 */
function fullRegister(instructions: string): void {
  try {
    writeInstructions(instructions);
  } catch {
    // silently skip
  }

  // Claude Code: ~/.claude/CLAUDE.md
  try {
    upsertSection(path.join(os.homedir(), '.claude', 'CLAUDE.md'));
  } catch {
    // silently skip
  }

  // Cursor: ~/.cursor/rules/dokkimi.md
  try {
    const rulesPath = path.join(os.homedir(), '.cursor', 'rules', 'dokkimi.md');
    fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
    fs.writeFileSync(rulesPath, `# Dokkimi\n\n${HINT}\n`, 'utf-8');
  } catch {
    // silently skip
  }

  // GitHub Copilot: ~/.github/copilot-instructions.md
  try {
    upsertSection(
      path.join(os.homedir(), '.github', 'copilot-instructions.md'),
    );
  } catch {
    // silently skip
  }
}

/**
 * Ensures LLM context files exist, writing only those that are missing.
 * Used on normal startup when the version hasn't changed.
 */
function ensureMissing(instructions: string): void {
  if (!fs.existsSync(INSTRUCTIONS_PATH)) {
    try {
      writeInstructions(instructions);
    } catch {
      // silently skip
    }
  }

  const claudePath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  if (!hasDokkimiSection(claudePath)) {
    try {
      upsertSection(claudePath);
    } catch {
      // silently skip
    }
  }

  const cursorPath = path.join(os.homedir(), '.cursor', 'rules', 'dokkimi.md');
  if (!fs.existsSync(cursorPath)) {
    try {
      fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
      fs.writeFileSync(cursorPath, `# Dokkimi\n\n${HINT}\n`, 'utf-8');
    } catch {
      // silently skip
    }
  }

  const copilotPath = path.join(
    os.homedir(),
    '.github',
    'copilot-instructions.md',
  );
  if (!hasDokkimiSection(copilotPath)) {
    try {
      upsertSection(copilotPath);
    } catch {
      // silently skip
    }
  }
}

export function registerLlmContext(): void {
  const instructions = readInstructionsSource();
  if (!instructions) {
    return;
  }

  const appVersion = getCliVersion();
  const storedVersion = readStoredVersion();

  if (storedVersion !== appVersion) {
    fullRegister(instructions);
    writeVersion(appVersion);
  } else {
    ensureMissing(instructions);
  }
}
