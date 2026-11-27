import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DOKKIMI_VERSION } from '@dokkimi/config';
import { addMcpEntry, MCP_CONFIG_PATHS } from './mcp-config';
import { createFile, replaceFile } from './safe-write';

const DOKKIMI_DIR = path.join(os.homedir(), '.dokkimi');
const INSTRUCTIONS_PATH = path.join(DOKKIMI_DIR, 'dokkimi-instructions.md');
const VERSION_PATH = path.join(DOKKIMI_DIR, '.version');
const MCP_WARNED_PATH = path.join(DOKKIMI_DIR, '.mcp-warned');
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DOKKIMI_MARKER = '<!-- dokkimi -->';

const HINT = `When the user asks about Dokkimi, .dokkimi/ files, or writing test definitions for microservices, use the Dokkimi MCP tools (get_reference, validate_file, list_fragments, resolve_definition, run_tests, dump_results). Call get_reference first to look up the relevant spec section before writing or editing definition files. Do not guess field names, operators, or file structure.

If the Dokkimi MCP tools are unavailable, try restarting the server by running \`dokkimi mcp\` in the shell. If that also fails, fall back to reading ${INSTRUCTIONS_PATH} for the complete Dokkimi reference and use the \`dokkimi\` CLI directly (e.g. \`dokkimi validate\`, \`dokkimi run\`, \`dokkimi dump\`).`;

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

/**
 * Adds or updates the Dokkimi section of a file that is the user's own (the
 * global CLAUDE.md, Copilot instructions), leaving the rest as it was. A file
 * that can't be read is left alone: before, it was replaced by the section.
 */
function upsertSection(filePath: string): void {
  const section = `${DOKKIMI_MARKER}\n# Dokkimi\n\n${HINT}\n${DOKKIMI_MARKER}`;

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
    createFile(filePath, section + '\n');
    return;
  }

  const updated = content.includes(DOKKIMI_MARKER)
    ? content.replace(
        new RegExp(`${DOKKIMI_MARKER}[\\s\\S]*?${DOKKIMI_MARKER}`, 'g'),
        section,
      )
    : content.trimEnd() + '\n\n' + section + '\n';
  if (updated !== content) {
    replaceFile(filePath, updated);
  }
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
 * Prints registration problems at most once a day, and only to a terminal, so
 * MCP stdio, npm postinstall and scripted runs neither get the noise nor use up
 * the day's warning. `dokkimi doctor` always reports them.
 */
function warnOncePerDay(problems: string[]): void {
  if (!process.stderr.isTTY) {
    return;
  }
  try {
    if (Date.now() - fs.statSync(MCP_WARNED_PATH).mtimeMs < ONE_DAY_MS) {
      return;
    }
  } catch {
    // Not warned yet
  }
  for (const problem of problems) {
    console.error(
      `Warning: could not register the Dokkimi MCP server: ${problem}`,
    );
  }
  console.error("Run 'dokkimi doctor' for details.");
  try {
    fs.mkdirSync(DOKKIMI_DIR, { recursive: true });
    fs.writeFileSync(MCP_WARNED_PATH, new Date().toISOString(), 'utf-8');
  } catch {
    // silently skip
  }
}

/**
 * Ensures the MCP server is registered in global AI tool settings.
 */
function registerMcpServer(): void {
  const problems: string[] = [];
  for (const configPath of MCP_CONFIG_PATHS) {
    try {
      addMcpEntry(configPath);
    } catch (err) {
      problems.push(`${configPath} ${(err as Error).message}`);
    }
  }
  if (problems.length > 0) {
    warnOncePerDay(problems);
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

  // MCP server config in global AI tool settings
  registerMcpServer();
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

  // MCP server config (ensure present)
  registerMcpServer();
}

export function registerLlmContext(): void {
  const instructions = readInstructionsSource();
  if (!instructions) {
    return;
  }

  const storedVersion = readStoredVersion();

  if (storedVersion !== DOKKIMI_VERSION) {
    fullRegister(instructions);
    writeVersion(DOKKIMI_VERSION);
  } else {
    ensureMissing(instructions);
  }
}
