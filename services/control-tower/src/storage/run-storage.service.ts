import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
/**
 * Filesystem-backed run storage for local/desktop mode.
 *
 * Layout:
 *   {storageDir}/instances/{instanceId}/definition.json
 *   {storageDir}/instances/{instanceId}/db-init-files/{itemName}/{filename}
 *   {storageDir}/instances/{instanceId}/artifacts/{folder}/{filename}
 *     where folder = 'screenshot' | 'diff' | 'failure' (failure for nameless captures)
 */
export interface ArtifactPath {
  folder: string;
  filename: string;
  fullPath: string;
  uri: string; // path relative to storageDir, used as Artifact.uri
}
@Injectable()
export class RunStorageService {
  private readonly logger = new Logger(RunStorageService.name);
  private readonly storageDir: string;

  constructor(private readonly configService: ConfigService) {
    this.storageDir = this.configService.get<string>('STORAGE_DIR')!;

    const instancesDir = path.join(this.storageDir, 'instances');
    if (!fsSync.existsSync(instancesDir)) {
      fsSync.mkdirSync(instancesDir, { recursive: true });
      this.logger.log(`Created instances directory: ${instancesDir}`);
    }
  }

  async writeDefinition(
    instanceId: string,
    content: Record<string, unknown>,
  ): Promise<void> {
    const dir = this.instanceDir(instanceId);
    await fs.mkdir(dir, { recursive: true });

    const filePath = path.join(dir, 'definition.json');
    await fs.writeFile(filePath, JSON.stringify(content, null, 2));
    this.logger.log(`Wrote definition: ${filePath}`);
  }

  async hasDefinition(instanceId: string): Promise<boolean> {
    const filePath = path.join(this.instanceDir(instanceId), 'definition.json');
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async readDefinition(instanceId: string): Promise<Record<string, unknown>> {
    const filePath = path.join(this.instanceDir(instanceId), 'definition.json');

    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (e: unknown) {
      if (
        e instanceof Error &&
        (e as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        throw new NotFoundException(
          `Definition not found for instance=${instanceId}`,
        );
      }
      throw e;
    }
  }

  async writeInitFiles(
    instanceId: string,
    items: {
      name: string;
      type: string;
      database?: string | null;
      initFiles?: { filename: string; content: Buffer }[] | null;
    }[],
  ): Promise<void> {
    for (const item of items) {
      if (item.type !== 'DATABASE') {
        continue;
      }

      const isMongo = item.database?.toLowerCase() === 'mongodb';
      const hasUserInitFiles = !!item.initFiles?.length;

      if (!hasUserInitFiles && !isMongo) {
        continue;
      }

      const dir = this.initFilesDir(instanceId, item.name);
      await fs.mkdir(dir, { recursive: true });

      if (hasUserInitFiles) {
        for (let i = 0; i < item.initFiles!.length; i++) {
          const initFile = item.initFiles![i];
          const paddedIndex = String(i).padStart(2, '0');
          const safeName = path
            .basename(initFile.filename)
            .replace(/[^a-zA-Z0-9_.-]/g, '_');
          const filename = `${paddedIndex}_${safeName}`;
          const fullPath = path.join(dir, filename);
          if (!fullPath.startsWith(dir + path.sep)) {
            this.logger.warn(
              `Skipping init file with unsafe name: "${initFile.filename}"`,
            );
            continue;
          }
          await fs.writeFile(fullPath, initFile.content);
        }
      }

      if (isMongo) {
        const sentinelIndex = String(item.initFiles?.length ?? 0).padStart(
          2,
          '0',
        );
        const sentinel = `db.getSiblingDB('dokkimi_internal').getCollection('health').insertOne({_id: "ready"});\n`;
        await fs.writeFile(
          path.join(dir, `${sentinelIndex}_dokkimi_ready.js`),
          sentinel,
        );
      }
    }
  }

  getInitFilesDir(instanceId: string, itemName: string): string {
    return this.initFilesDir(instanceId, itemName);
  }

  /**
   * Persist a binary artifact under the instance's artifacts directory.
   *
   * Path convention:
   *   - Named (visualMatch capture/diff, explicit screenshot): {type}/{name}.{ext}
   *   - Nameless (debug failure capture): failure/{stepIndex}.{subStepIndex}-failure.{ext}
   *
   * The caller is expected to have validated `name` against the sanitization
   * rules (alphanumeric + dash + underscore, max 64) at the controller layer.
   * This method does a defensive basename + sep check as a final guard.
   */
  async persistArtifact(
    instanceId: string,
    type: 'screenshot' | 'diff' | 'html',
    payload: Buffer,
    position: { stepIndex: number; subStepIndex: number },
    name: string | null,
    isFailure = false,
  ): Promise<ArtifactPath> {
    const artifactsRoot = this.artifactsDir(instanceId);
    const folder = isFailure ? 'failure' : type;
    const ext = type === 'html' ? 'html' : 'png';
    const filename =
      name !== null
        ? `${name}.${ext}`
        : `${position.stepIndex}.${position.subStepIndex}-failure.${ext}`;

    const dir = path.join(artifactsRoot, folder);
    await fs.mkdir(dir, { recursive: true });

    const fullPath = path.join(dir, filename);
    if (
      path.basename(fullPath) !== filename ||
      !fullPath.startsWith(dir + path.sep)
    ) {
      throw new Error(`Refusing to write artifact to unsafe path: ${fullPath}`);
    }
    await fs.writeFile(fullPath, payload);

    const uri = path.relative(this.storageDir, fullPath);
    return { folder, filename, fullPath, uri };
  }

  async deleteInstance(instanceId: string): Promise<void> {
    const dir = this.instanceDir(instanceId);
    try {
      await fs.rm(dir, { recursive: true });
      this.logger.log(`Deleted instance storage: ${dir}`);
    } catch (e: unknown) {
      if (
        !(e instanceof Error) ||
        (e as NodeJS.ErrnoException).code !== 'ENOENT'
      ) {
        throw e;
      }
    }
  }

  private instanceDir(instanceId: string): string {
    return path.join(this.storageDir, 'instances', instanceId);
  }

  private initFilesDir(instanceId: string, itemName: string): string {
    return path.join(this.instanceDir(instanceId), 'db-init-files', itemName);
  }

  /**
   * Resolves a stored relative `uri` (as returned by persistArtifact /
   * persistBaseline) to an absolute filesystem path.
   */
  absoluteUri(uri: string): string {
    return path.join(this.storageDir, uri);
  }

  private artifactsDir(instanceId: string): string {
    return path.join(this.instanceDir(instanceId), 'artifacts');
  }

  /**
   * Persist a visual-regression baseline for the run. Baselines are user
   * inputs (checked into .dokkimi/<project>/baselines/<name>.png in git).
   * The CLI uploads them at run-start; CT writes them under the instance
   * directory so the post-run diff job can read them locally without
   * touching the user's filesystem.
   *
   * Path: instances/<instanceId>/baselines/<name>.png
   * Returned uri is relative to storageDir, mirroring artifacts.
   */
  async persistBaseline(
    instanceId: string,
    name: string,
    payload: Buffer,
  ): Promise<{ fullPath: string; uri: string }> {
    const dir = this.baselinesDir(instanceId);
    await fs.mkdir(dir, { recursive: true });

    const filename = `${name}.png`;
    const fullPath = path.join(dir, filename);
    if (
      path.basename(fullPath) !== filename ||
      !fullPath.startsWith(dir + path.sep)
    ) {
      throw new Error(`Refusing to write baseline to unsafe path: ${fullPath}`);
    }
    await fs.writeFile(fullPath, payload);

    const uri = path.relative(this.storageDir, fullPath);
    return { fullPath, uri };
  }

  /**
   * Returns the absolute filesystem path for an instance's baseline file,
   * or null if no baseline exists for that name. Used by the post-run
   * visualMatch diff job.
   */
  baselinePath(instanceId: string, name: string): string {
    return path.join(this.baselinesDir(instanceId), `${name}.png`);
  }

  async hasBaseline(instanceId: string, name: string): Promise<boolean> {
    try {
      await fs.access(this.baselinePath(instanceId, name));
      return true;
    } catch {
      return false;
    }
  }

  private baselinesDir(instanceId: string): string {
    return path.join(this.instanceDir(instanceId), 'baselines');
  }

  async deleteGeneratedFiles(): Promise<void> {
    const dir = path.join(os.homedir(), '.dokkimi', 'generated');
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
