import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

/**
 * Reads and edits the MCP config files owned by other tools (Claude Code,
 * Cursor). These hold the user's other MCP servers, credentials and project
 * state, so the rule throughout is: if we can't fully understand the file or
 * replace it safely, throw and leave it untouched.
 */

type JsonObject = Record<string, unknown>;

export const MCP_CONFIG_PATHS = [
  path.join(os.homedir(), '.claude.json'),
  path.join(os.homedir(), '.cursor', 'mcp.json'),
];

const MCP_ENTRY = { command: 'dokkimi', args: ['mcp'] };

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

/** Returns null only if the file doesn't exist. Throws if it can't be used. */
function readConfig(
  configPath: string,
): { config: JsonObject; servers: JsonObject } | null {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(configPath);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') {
      return null;
    }
    throw new Error(
      `could not be read (${errorCode(err) ?? 'unknown error'})`,
      { cause: err },
    );
  }

  let config: unknown;
  try {
    // Rejects invalid UTF-8, which would otherwise be silently replaced on
    // write, and strips a BOM.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    config = JSON.parse(text);
  } catch {
    // Don't surface the parser's message: it quotes file contents, which can
    // include credentials.
    throw new Error('is not valid JSON');
  }

  if (!isObject(config)) {
    throw new Error('is not a JSON object');
  }
  const servers = config.mcpServers ?? {};
  if (!isObject(servers)) {
    throw new Error('has an "mcpServers" value that is not an object');
  }
  return { config, servers };
}

/**
 * Replaces an existing file via temp file + rename, so a concurrent reader
 * never sees a partial file. Keeps symlinks, permissions and ownership.
 *
 * A rename only needs write access to the directory and gives the file a new
 * inode, so read-only and hard-linked files are refused explicitly.
 */
function replaceConfig(configPath: string, config: JsonObject): void {
  let tmp: string | undefined;
  try {
    const target = fs.realpathSync(configPath);
    fs.accessSync(target, fs.constants.W_OK);
    const { mode, uid, gid, nlink } = fs.statSync(target);
    if (nlink > 1) {
      throw new Error('hard-linked file');
    }
    tmp = `${target}.dokkimi-${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    // chown first: it can clear mode bits
    fs.chownSync(tmp, uid, gid);
    fs.chmodSync(tmp, mode & 0o777);
    fs.renameSync(tmp, target);
  } catch (err) {
    if (tmp) {
      fs.rmSync(tmp, { force: true });
    }
    throw new Error(
      `could not be updated (${errorCode(err) ?? (err as Error).message})`,
      { cause: err },
    );
  }
}

/** Creates the file, failing rather than overwriting if one has appeared. */
function createConfig(configPath: string, config: JsonObject): void {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (err) {
    throw new Error(
      `could not be created (${errorCode(err) ?? 'unknown error'})`,
      { cause: err },
    );
  }
}

/** Adds the dokkimi entry, leaving an existing one (even customized) alone. */
export function addMcpEntry(configPath: string): void {
  const current = readConfig(configPath);
  if (!current) {
    createConfig(configPath, { mcpServers: { dokkimi: MCP_ENTRY } });
    return;
  }
  if (current.servers.dokkimi) {
    return;
  }
  replaceConfig(configPath, {
    ...current.config,
    mcpServers: { ...current.servers, dokkimi: MCP_ENTRY },
  });
}

export function removeMcpEntry(configPath: string): void {
  const current = readConfig(configPath);
  if (!current?.servers.dokkimi) {
    return;
  }
  const { dokkimi: _removed, ...servers } = current.servers;
  replaceConfig(configPath, { ...current.config, mcpServers: servers });
}

/** Describes why dokkimi isn't registered in this file, or null if it is. */
export function getMcpConfigProblem(configPath: string): string | null {
  try {
    return readConfig(configPath)?.servers.dokkimi
      ? null
      : `${configPath} has no dokkimi entry`;
  } catch (err) {
    return `${configPath} ${(err as Error).message}`;
  }
}
