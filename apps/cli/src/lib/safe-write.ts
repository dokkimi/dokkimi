import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

/**
 * Writes files that belong to the user or to other tools (MCP configs, the
 * global CLAUDE.md), where a half-written or clobbered file loses their data.
 */

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

/**
 * Replaces an existing file via temp file + rename, so a concurrent reader
 * never sees a partial file. Keeps symlinks, permissions and ownership.
 *
 * A rename only needs write access to the directory and gives the file a new
 * inode, so read-only and hard-linked files are refused explicitly.
 */
export function replaceFile(filePath: string, content: string): void {
  let tmp: string | undefined;
  try {
    const target = fs.realpathSync(filePath);
    fs.accessSync(target, fs.constants.W_OK);
    const { mode, uid, gid, nlink } = fs.statSync(target);
    if (nlink > 1) {
      throw new Error('hard-linked file');
    }
    tmp = `${target}.dokkimi-${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, content, { flag: 'wx', mode: 0o600 });
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

/**
 * Creates the file, failing rather than overwriting if one has appeared.
 * mode: e.g. 0o600 for a file that can hold credentials; by default the
 * usual permissions (umask).
 */
export function createFile(
  filePath: string,
  content: string,
  mode?: number,
): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, { flag: 'wx', mode });
  } catch (err) {
    throw new Error(
      `could not be created (${errorCode(err) ?? 'unknown error'})`,
      { cause: err },
    );
  }
}
