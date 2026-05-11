import * as fs from 'fs';
import * as path from 'path';
import { pack, type Pack } from 'tar-stream';
import type { Readable } from 'stream';

/**
 * Create a tar archive stream from a directory's contents.
 * Pure Node implementation — no shell `tar` binary required.
 */
export function createDirectoryTar(dir: string): Readable {
  const archive = pack();
  packDirectory(archive, dir, '.');
  archive.finalize();
  return archive;
}

function packDirectory(
  archive: Pack,
  baseDir: string,
  relativePath: string,
): void {
  const fullPath = path.join(baseDir, relativePath);
  const entries = fs.readdirSync(fullPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryRelative = path.join(relativePath, entry.name);
    const entryFull = path.join(baseDir, entryRelative);

    if (entry.isDirectory()) {
      packDirectory(archive, baseDir, entryRelative);
    } else if (entry.isFile()) {
      const stat = fs.statSync(entryFull);
      const content = fs.readFileSync(entryFull);
      archive.entry(
        { name: entryRelative, size: stat.size, mode: stat.mode },
        content,
      );
    }
  }
}
