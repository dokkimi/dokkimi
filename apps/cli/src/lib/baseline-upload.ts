import * as fs from 'fs';
import * as path from 'path';

/**
 * Locates the baselines directory for a definition. By convention baselines
 * live at `<project-root>/baselines/<name>.png`, where the project root is
 * typically the parent of the directory containing the definition file
 * (e.g. `.dokkimi/<project>/definitions/x.yaml` → `.dokkimi/<project>/baselines/`).
 *
 * Walks upward from the source file looking for a `baselines/` directory.
 * Returns null if none is found within the project tree.
 */
export function findBaselinesDir(sourceFile: string): string | null {
  let dir = path.dirname(sourceFile);
  // Walk up at most 3 levels — covers <project>/definitions/<file> and
  // <project>/<file> layouts without scanning the whole filesystem.
  for (let i = 0; i < 3; i++) {
    const candidate = path.join(dir, 'baselines');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
  return null;
}

/**
 * Lists all .png files in the baselines directory. Returns an array of
 * { name, path } where name is the file's stem (no extension).
 */
export function listBaselineFiles(
  baselinesDir: string,
): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  for (const entry of fs.readdirSync(baselinesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.png')) {
      continue;
    }
    const stem = path.basename(entry.name, path.extname(entry.name));
    out.push({ name: stem, path: path.join(baselinesDir, entry.name) });
  }
  return out;
}

/**
 * Posts a single baseline PNG to CT's POST /baselines endpoint via multipart.
 * Returns null on success, an error message otherwise.
 */
export async function uploadBaseline(
  ctUrl: string,
  instanceId: string,
  name: string,
  filePath: string,
  timeoutMs = 30_000,
): Promise<string | null> {
  let payload: Buffer;
  try {
    payload = fs.readFileSync(filePath);
  } catch (err) {
    return err instanceof Error ? err.message : `read ${filePath} failed`;
  }

  const form = new FormData();
  form.append('instanceId', instanceId);
  form.append('name', name);
  // Web FormData wants a Blob/File for the binary part. Wrap the Buffer.
  form.append(
    'payload',
    new Blob([new Uint8Array(payload)], { type: 'image/png' }),
    `${name}.png`,
  );

  try {
    const res = await fetch(`${ctUrl}/baselines`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      return null;
    }
    let detail: string;
    try {
      const body = (await res.json()) as Record<string, unknown>;
      detail = (body.message || body.error || JSON.stringify(body)) as string;
    } catch {
      detail = `HTTP ${res.status}`;
    }
    return detail;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return 'Request timed out — Control Tower may not be running';
    }
    return err instanceof Error ? err.message : 'Connection failed';
  }
}

/**
 * Uploads all baselines in the source file's project tree to CT.
 * Reports per-file success/failure to console.error so the user sees what
 * happened without flooding stdout. Returns the count of files uploaded.
 */
/**
 * Extracts screenshot names that have visual matching enabled (i.e. a truthy
 * `match` block) from a resolved definition. Only these need baselines.
 */
export function extractVisualMatchNames(
  definition: Record<string, unknown>,
): Set<string> {
  const names = new Set<string>();
  const tests = definition.tests;
  if (!Array.isArray(tests)) {
    return names;
  }
  for (const test of tests) {
    const steps = (test as Record<string, unknown>).steps;
    if (!Array.isArray(steps)) {
      continue;
    }
    for (const step of steps) {
      const action = (step as Record<string, unknown>)?.action as
        | Record<string, unknown>
        | undefined;
      if (action?.type !== 'ui' || !Array.isArray(action.steps)) {
        continue;
      }
      for (const sub of action.steps as unknown[]) {
        if (!sub || typeof sub !== 'object') {
          continue;
        }
        const ss = (sub as Record<string, unknown>).screenshot;
        if (!ss || typeof ss !== 'object') {
          continue;
        }
        const obj = ss as Record<string, unknown>;
        if (obj.match && typeof obj.name === 'string') {
          names.add(obj.name);
        }
      }
    }
  }
  return names;
}

export async function uploadBaselinesForDefinition(
  ctUrl: string,
  instanceId: string,
  sourceFile: string,
  definition?: Record<string, unknown>,
): Promise<number> {
  const baselinesDir = findBaselinesDir(sourceFile);
  if (!baselinesDir) {
    return 0;
  }
  let files = listBaselineFiles(baselinesDir);
  if (files.length === 0) {
    return 0;
  }
  if (definition) {
    const needed = extractVisualMatchNames(definition);
    if (needed.size > 0) {
      files = files.filter((f) => needed.has(f.name));
    }
  }
  let uploaded = 0;
  for (const file of files) {
    const err = await uploadBaseline(ctUrl, instanceId, file.name, file.path);
    if (err) {
      console.error(
        `\x1b[33mwarn\x1b[0m  failed to upload baseline "${file.name}": ${err}`,
      );
    } else {
      uploaded++;
    }
  }
  return uploaded;
}
