import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { runDirPath } from '@dokkimi/config';
import * as fs from 'fs/promises';
import * as path from 'path';
/**
 * Filesystem-backed run storage for local/desktop mode.
 *
 * Layout:
 *   {projectPath}/.dokkimi/__runs__/{YYYYMMDD-HHmmss}/snapshots/{definitionName}/definition.json
 *   {projectPath}/.dokkimi/__runs__/{YYYYMMDD-HHmmss}/snapshots/{definitionName}/db-init-files/{itemName}/{filename}
 *   {projectPath}/.dokkimi/__runs__/{YYYYMMDD-HHmmss}/snapshots/{definitionName}/artifacts/{folder}/{filename}
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
    projectPath: string | null,
    createdAt: Date,
    definitionName: string,
  ): void {
    if (projectPath) {
      const dir = path.join(
        runDirPath(projectPath, createdAt),
        'snapshots',
        definitionName,
      );
      this.instancePaths.set(instanceId, dir);
    }
  }

  async ensureRunsExcluded(projectPath: string): Promise<void> {
    const repoRoot = await this.findGitRoot(projectPath);
    if (!repoRoot) {
      return;
    }

    await this.ensureGitignoreEntry(repoRoot, projectPath);
    await this.ensureVscodeWatcherExclude(repoRoot);
  }

  private async ensureGitignoreEntry(
    repoRoot: string,
    projectPath: string,
  ): Promise<void> {
    const relative = path.relative(repoRoot, projectPath);
    const prefix = relative === '' ? '' : `${relative}/`;
    const entry = `${prefix}.dokkimi/__runs__/`;
    const gitignorePath = path.join(repoRoot, '.gitignore');

    try {
      const content = await fs.readFile(gitignorePath, 'utf-8');
      if (content.split('\n').some((line) => line.trim() === entry)) {
        return;
      }
      const separator = content.endsWith('\n') ? '' : '\n';
      await fs.appendFile(gitignorePath, `${separator}\n# Dokkimi\n${entry}\n`);
    } catch (e: unknown) {
      if (
        e instanceof Error &&
        (e as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        await fs.writeFile(gitignorePath, `# Dokkimi\n${entry}\n`);
      }
    }
  }

  private async ensureVscodeWatcherExclude(repoRoot: string): Promise<void> {
    const settingsPath = path.join(repoRoot, '.vscode', 'settings.json');
    const excludeKey = '**/.dokkimi/__runs__/**';

    try {
      const raw = await fs.readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(raw);
      const exclude = settings['files.watcherExclude'] ?? {};
      if (exclude[excludeKey] === true) {
        return;
      }
      exclude[excludeKey] = true;
      settings['files.watcherExclude'] = exclude;
      await fs.writeFile(
        settingsPath,
        JSON.stringify(settings, null, 2) + '\n',
      );
    } catch (e: unknown) {
      if (
        e instanceof Error &&
        (e as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        await fs.mkdir(path.join(repoRoot, '.vscode'), { recursive: true });
        await fs.writeFile(
          settingsPath,
          JSON.stringify(
            { 'files.watcherExclude': { [excludeKey]: true } },
            null,
            2,
          ) + '\n',
        );
      }
    }
  }

  async pruneRunDirs(
    projectPath: string,
    maxRunHistory: number,
  ): Promise<void> {
    const runsDir = path.join(projectPath, '.dokkimi', '__runs__');
    let entries: string[];
    try {
      entries = await fs.readdir(runsDir);
    } catch {
      return;
    }
    const sorted = entries.sort().reverse();
    const toDelete = sorted.slice(maxRunHistory);
    for (const entry of toDelete) {
      const dir = path.join(runsDir, entry);
      try {
        await fs.rm(dir, { recursive: true });
        this.logger.log(`Pruned run directory: ${dir}`);
      } catch {}
    }
  }

  private async findGitRoot(startPath: string): Promise<string | null> {
    let dir = path.resolve(startPath);
    const root = path.parse(dir).root;
    while (dir !== root) {
      try {
        await fs.access(path.join(dir, '.git'));
        return dir;
      } catch {}
      dir = path.dirname(dir);
    }
    return null;
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

  /**
   * Resolves a stored relative `uri` (as returned by persistArtifact /
   * persistBaseline) to an absolute filesystem path.
   */
  absoluteUri(uri: string): string {
    return uri;
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

    return { fullPath, uri: fullPath };
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
}
