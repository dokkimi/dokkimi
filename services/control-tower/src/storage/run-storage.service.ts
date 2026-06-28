import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { runDirPath } from '@dokkimi/config';
import { PrismaService } from '../prisma/prisma.service';
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

  constructor(private readonly prisma: PrismaService) {}

  hasInstance(instanceId: string): boolean {
    return this.instancePaths.has(instanceId);
  }

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
    const dir = await this.resolveInstanceDir(instanceId);
    await fs.mkdir(dir, { recursive: true });

    const filePath = path.join(dir, 'definition.json');
    await fs.writeFile(filePath, JSON.stringify(content, null, 2));
    this.logger.log(`Wrote definition: ${filePath}`);
  }

  async hasDefinition(instanceId: string): Promise<boolean> {
    const dir = await this.resolveInstanceDir(instanceId);
    const filePath = path.join(dir, 'definition.json');
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async readDefinition(instanceId: string): Promise<Record<string, unknown>> {
    const dir = await this.resolveInstanceDir(instanceId);
    const filePath = path.join(dir, 'definition.json');

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

      const dir = await this.resolveInitFilesDir(instanceId, item.name);
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

  async getInitFilesDir(instanceId: string, itemName: string): Promise<string> {
    return this.resolveInitFilesDir(instanceId, itemName);
  }

  async writeMountFiles(
    instanceId: string,
    items: {
      name: string;
      type: string;
      mountFiles?: { source: string; target: string; content: Buffer }[] | null;
    }[],
  ): Promise<void> {
    for (const item of items) {
      if (item.type !== 'SERVICE' || !item.mountFiles?.length) {
        continue;
      }
      const dir = await this.resolveMountFilesDir(instanceId, item.name);
      await fs.mkdir(dir, { recursive: true });
      for (const mf of item.mountFiles) {
        const safeName = path
          .basename(mf.source)
          .replace(/[^a-zA-Z0-9_.-]/g, '_');
        const fullPath = path.join(dir, safeName);
        if (!fullPath.startsWith(dir + path.sep)) {
          this.logger.warn(
            `Skipping mount file with unsafe name: "${mf.source}"`,
          );
          continue;
        }
        await fs.writeFile(fullPath, mf.content);
      }
    }
  }

  async getMountFilesDir(
    instanceId: string,
    itemName: string,
  ): Promise<string> {
    return this.resolveMountFilesDir(instanceId, itemName);
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
    const artifactsRoot = await this.resolveArtifactsDir(instanceId);
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
    const cached = this.instancePaths.get(instanceId);
    if (cached) {
      return cached;
    }
    throw new Error(
      `No storage path registered for instance ${instanceId}. ` +
        `Call registerInstance() or resolveInstanceDir() before accessing storage.`,
    );
  }

  async resolveInstanceDir(instanceId: string): Promise<string> {
    const cached = this.instancePaths.get(instanceId);
    if (cached) {
      return cached;
    }

    const instance = await this.prisma.namespaceInstance.findUnique({
      where: { id: instanceId },
      include: { run: true },
    });
    if (!instance?.run?.projectPath) {
      throw new Error(
        `Cannot resolve storage path for instance ${instanceId}: run or projectPath not found.`,
      );
    }

    const dir = path.join(
      runDirPath(instance.run.projectPath, instance.run.createdAt),
      'snapshots',
      instance.name,
    );
    this.instancePaths.set(instanceId, dir);
    return dir;
  }

  private initFilesDir(instanceId: string, itemName: string): string {
    return path.join(this.instanceDir(instanceId), 'db-init-files', itemName);
  }

  private async resolveInitFilesDir(
    instanceId: string,
    itemName: string,
  ): Promise<string> {
    const dir = await this.resolveInstanceDir(instanceId);
    return path.join(dir, 'db-init-files', itemName);
  }

  private async resolveMountFilesDir(
    instanceId: string,
    itemName: string,
  ): Promise<string> {
    const dir = await this.resolveInstanceDir(instanceId);
    return path.join(dir, 'mount-files', itemName);
  }

  absoluteUri(uri: string): string {
    return uri;
  }

  private artifactsDir(instanceId: string): string {
    return path.join(this.instanceDir(instanceId), 'artifacts');
  }

  private async resolveArtifactsDir(instanceId: string): Promise<string> {
    const dir = await this.resolveInstanceDir(instanceId);
    return path.join(dir, 'artifacts');
  }

  async persistBaseline(
    instanceId: string,
    name: string,
    payload: Buffer,
  ): Promise<{ fullPath: string; uri: string }> {
    const dir = await this.resolveBaselinesDir(instanceId);
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

  async baselinePath(instanceId: string, name: string): Promise<string> {
    const dir = await this.resolveBaselinesDir(instanceId);
    return path.join(dir, `${name}.png`);
  }

  async hasBaseline(instanceId: string, name: string): Promise<boolean> {
    try {
      await fs.access(await this.baselinePath(instanceId, name));
      return true;
    } catch {
      return false;
    }
  }

  getBaselinesDir(instanceId: string): string {
    return this.baselinesDir(instanceId);
  }

  private baselinesDir(instanceId: string): string {
    return path.join(this.instanceDir(instanceId), 'baselines');
  }

  private async resolveBaselinesDir(instanceId: string): Promise<string> {
    const dir = await this.resolveInstanceDir(instanceId);
    return path.join(dir, 'baselines');
  }
}
