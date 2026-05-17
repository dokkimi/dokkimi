import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getCliVersion } from './version';

const DOKKIMI_DIR = path.join(os.homedir(), '.dokkimi');
const INSTRUCTIONS_PATH = path.join(DOKKIMI_DIR, 'dokkimi-instructions.md');
const VERSION_PATH = path.join(DOKKIMI_DIR, '.version');
const DOKKIMI_MARKER = '<!-- dokkimi -->';

const HINT = `When the user asks about Dokkimi, .dokkimi/ files, or writing test definitions for microservices, use the Dokkimi MCP tools (get_reference, validate_file, list_fragments, resolve_definition, run_tests, dump_results). Call get_reference first to look up the relevant spec section before writing or editing definition files. Do not guess field names, operators, or file structure.`;

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
 * Ensures the MCP server is registered in global AI tool settings.
 */
function registerMcpServer(): void {
  const mcpConfig = { command: 'dokkimi', args: ['mcp'] };

  // Claude Code: ~/.claude.json
  try {
    const claudeConfig = path.join(os.homedir(), '.claude.json');
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(fs.readFileSync(claudeConfig, 'utf-8'));
    } catch {
      // File doesn't exist or is invalid — start fresh
    }
    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      config.mcpServers = {};
    }
    (config.mcpServers as Record<string, unknown>).dokkimi = mcpConfig;
    fs.writeFileSync(claudeConfig, JSON.stringify(config, null, 2) + '\n');
  } catch {
    // silently skip
  }

  // Cursor: ~/.cursor/mcp.json
  try {
    const cursorMcp = path.join(os.homedir(), '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(cursorMcp), { recursive: true });
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(fs.readFileSync(cursorMcp, 'utf-8'));
    } catch {
      // File doesn't exist or is invalid — start fresh
    }
    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      config.mcpServers = {};
    }
    (config.mcpServers as Record<string, unknown>).dokkimi = mcpConfig;
    fs.writeFileSync(cursorMcp, JSON.stringify(config, null, 2) + '\n');
  } catch {
    // silently skip
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

  const appVersion = getCliVersion();
  const storedVersion = readStoredVersion();

  if (storedVersion !== appVersion) {
    fullRegister(instructions);
    writeVersion(appVersion);
  } else {
    ensureMissing(instructions);
  }
}
