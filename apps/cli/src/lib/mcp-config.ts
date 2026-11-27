import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createFile, replaceFile } from './safe-write';

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

const json = (config: JsonObject) => JSON.stringify(config, null, 2) + '\n';

/** Adds the dokkimi entry, leaving an existing one (even customized) alone. */
export function addMcpEntry(configPath: string): void {
  const current = readConfig(configPath);
  if (!current) {
    // MCP configs can hold credentials of the user's other servers
    createFile(configPath, json({ mcpServers: { dokkimi: MCP_ENTRY } }), 0o600);
    return;
  }
  if (current.servers.dokkimi) {
    return;
  }
  replaceFile(
    configPath,
    json({
      ...current.config,
      mcpServers: { ...current.servers, dokkimi: MCP_ENTRY },
    }),
  );
}

export function removeMcpEntry(configPath: string): void {
  const current = readConfig(configPath);
  if (!current?.servers.dokkimi) {
    return;
  }
  const { dokkimi: _removed, ...servers } = current.servers;
  replaceFile(configPath, json({ ...current.config, mcpServers: servers }));
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
