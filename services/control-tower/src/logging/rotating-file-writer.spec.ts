import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { RotatingFileWriter } from './rotating-file-writer';

describe('RotatingFileWriter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rfw-test-'));
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('should write lines to file', () => {
    const filePath = path.join(tempDir, 'app.log');
    const writer = new RotatingFileWriter(filePath);

    writer.write('line one');
    writer.write('line two');
    writer.close();

    const contents = fs.readFileSync(filePath, 'utf-8');
    expect(contents).toContain('line one');
    expect(contents).toContain('line two');
  });

  it('should rotate when exceeding max bytes', () => {
    const filePath = path.join(tempDir, 'app.log');
    const smallMax = 50;
    const writer = new RotatingFileWriter(filePath, smallMax);

    writer.write('a'.repeat(40));
    writer.write('b'.repeat(40));
    writer.close();

    expect(fs.existsSync(filePath + '.1')).toBe(true);
    const backup = fs.readFileSync(filePath + '.1', 'utf-8');
    expect(backup).toContain('a'.repeat(40));
  });

  it('should start with empty file after rotation', () => {
    const filePath = path.join(tempDir, 'app.log');
    const smallMax = 50;
    const writer = new RotatingFileWriter(filePath, smallMax);

    writer.write('a'.repeat(40));
    writer.write('b'.repeat(40));
    writer.close();

    const current = fs.readFileSync(filePath, 'utf-8');
    expect(current).toContain('b'.repeat(40));
    expect(current).not.toContain('a'.repeat(40));
  });

  it('should only keep 1 backup file', () => {
    const filePath = path.join(tempDir, 'app.log');
    const smallMax = 50;
    const writer = new RotatingFileWriter(filePath, smallMax);

    writer.write('a'.repeat(40));
    writer.write('b'.repeat(40));
    writer.write('c'.repeat(40));
    writer.close();

    expect(fs.existsSync(filePath + '.1')).toBe(true);
    expect(fs.existsSync(filePath + '.2')).toBe(false);
    const backup = fs.readFileSync(filePath + '.1', 'utf-8');
    expect(backup).toContain('b'.repeat(40));
  });

  it('should close file descriptor without error', () => {
    const filePath = path.join(tempDir, 'app.log');
    const writer = new RotatingFileWriter(filePath);

    writer.write('data');
    expect(() => writer.close()).not.toThrow();
  });
});
