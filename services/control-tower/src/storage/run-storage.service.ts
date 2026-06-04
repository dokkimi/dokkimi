import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { runDirPath } from '@dokkimi/config';
import * as fs from 'fs/promises';
import * as path from 'path';
/**
 * Filesystem-backed run storage for local/desktop mode.
 *
 * Layout:
 *   ~/.dokkimi/runs/{YYYYMMDD-HHmmss}/snapshots/{definitionName}/definition.json
 *   ~/.dokkimi/runs/{YYYYMMDD-HHmmss}/snapshots/{definitionName}/db-init-files/{itemName}/{filename}
 *   ~/.dokkimi/runs/{YYYYMMDD-HHmmss}/snapshots/{definitionName}/artifacts/{folder}/{filename}
 */
export interface ArtifactPath {
  folder: string;
  filename: string;
  fullPath: string;
  uri: string;
}

@Injectable()
export class RunStorageService {
  private readonly logger = new Logger(RunStorageService.name);
  private readonly instancePaths = new Map<string, string>();

  registerInstance(
    instanceId: string,
    projectPath: string,
    createdAt: Date,
    definitionName: string,
  ): void {
    const dir = path.join(
      runDirPath(projectPath, createdAt),
      'snapshots',
      definitionName,
    );
    this.instancePaths.set(instanceId, dir);
  }

  async deleteRunDir(projectPath: string, createdAt: Date): Promise<void> {
    const dir = runDirPath(projectPath, createdAt);
    try {
      await fs.rm(dir, { recursive: true });
      this.logger.log(`Deleted run directory: ${dir}`);
    } catch (e: unknown) {
      if (
        !(e instanceof Error) ||
        (e as NodeJS.ErrnoException).code !== 'ENOENT'
      ) {
        throw e;
      }
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

    return { folder, filename, fullPath, uri: fullPath };
  }

  async deleteInstance(instanceId: string): Promise<void> {
    const dir = this.instancePaths.get(instanceId);
    if (!dir) {
      return;
    }
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
    const dir = this.instancePaths.get(instanceId);
    if (!dir) {
      throw new Error(
        `No storage path registered for instance ${instanceId}. ` +
          `Call registerInstance() before accessing storage.`,
      );
    }
    return dir;
  }

  private initFilesDir(instanceId: string, itemName: string): string {
    return path.join(this.instanceDir(instanceId), 'db-init-files', itemName);
  }

  absoluteUri(uri: string): string {
    return uri;
  }

  private artifactsDir(instanceId: string): string {
    return path.join(this.instanceDir(instanceId), 'artifacts');
  }

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

    return { fullPath, uri: fullPath };
  }

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
}
