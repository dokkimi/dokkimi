import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Appends log lines to a file, rotating when the file exceeds a size limit.
 *
 * Rotation strategy (keeps 1 backup):
 *   app.log  ->  app.log.1  (overwritten each rotation)
 *   app.log  ->  (new, empty)
 */
export class RotatingFileWriter {
  private fd: number;
  private bytesWritten: number;
  private readonly maxBytes: number;
  private readonly filePath: string;
  private readonly backupPath: string;

  constructor(filePath: string, maxBytes: number = DEFAULT_MAX_BYTES) {
    this.filePath = filePath;
    this.maxBytes = maxBytes;
    this.backupPath = filePath + '.1';

    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    // Append so we don't lose data if the service restarts quickly
    this.fd = fs.openSync(filePath, 'a');
    try {
      this.bytesWritten = fs.fstatSync(this.fd).size;
    } catch {
      this.bytesWritten = 0;
    }
  }

  write(line: string): void {
    const buf = Buffer.from(line + '\n');

    if (this.bytesWritten + buf.length > this.maxBytes) {
      this.rotate();
    }

    try {
      fs.writeSync(this.fd, buf);
      this.bytesWritten += buf.length;
    } catch {
      // If write fails (disk full, etc.), silently drop rather than crash the service
    }
  }

  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      // ignore
    }
  }

  private rotate(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      // ignore
    }

    try {
      fs.renameSync(this.filePath, this.backupPath);
    } catch {
      // Backup rename failed — just truncate
    }

    this.fd = fs.openSync(this.filePath, 'w');
    this.bytesWritten = 0;
  }
}
