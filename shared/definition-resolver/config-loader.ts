import * as fs from 'fs';
import * as path from 'path';
import { parseDefinitionFile } from '@dokkimi/definition-validator';
import type { ResolverError } from './resolve';

const CONFIG_FILENAMES = ['config.yaml', 'config.yml', 'config.json'];

export { CONFIG_FILENAMES };

export interface DokkimiConfig {
  dokkimi?: string;
  env: Record<string, string>;
}

/**
 * Loads the project config file from the .dokkimi/ root directory.
 * Looks for config.yaml, config.yml, or config.json (first match wins).
 * Returns defaults if no config file exists.
 */
export function loadDokkimiConfig(
  dokkimiDir: string,
  errors: ResolverError[],
): DokkimiConfig {
  const empty: DokkimiConfig = { env: {} };

  for (const filename of CONFIG_FILENAMES) {
    const configPath = path.join(dokkimiDir, filename);
    if (!fs.existsSync(configPath)) {
      continue;
    }

    let parsed: unknown;
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      parsed = parseDefinitionFile(configPath, raw);
    } catch (e) {
      errors.push({
        file: configPath,
        errors: [
          `Failed to parse config: ${e instanceof Error ? e.message : e}`,
        ],
        warnings: [],
      });
      return empty;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push({
        file: configPath,
        errors: [
          `Config must be a YAML/JSON object, got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}`,
        ],
        warnings: [],
      });
      return empty;
    }

    const obj = parsed as Record<string, unknown>;
    const config: DokkimiConfig = { env: {} };

    // Parse dokkimi version field
    if (obj.dokkimi !== undefined) {
      if (typeof obj.dokkimi !== 'string' && typeof obj.dokkimi !== 'number') {
        errors.push({
          file: configPath,
          errors: ['"dokkimi" field must be a version string (e.g. "0.1.0")'],
          warnings: [],
        });
        return empty;
      }
      config.dokkimi = String(obj.dokkimi);
    }

    // Parse env map
    if (obj.env !== undefined) {
      if (!obj.env || typeof obj.env !== 'object' || Array.isArray(obj.env)) {
        errors.push({
          file: configPath,
          errors: ['"env" must be a plain object with string values'],
          warnings: [],
        });
        return empty;
      }

      for (const [key, value] of Object.entries(
        obj.env as Record<string, unknown>,
      )) {
        if (!/^\w+$/.test(key)) {
          errors.push({
            file: configPath,
            errors: [
              `env key "${key}" must be alphanumeric (letters, digits, underscores)`,
            ],
            warnings: [],
          });
          return empty;
        }
        if (typeof value !== 'string' && typeof value !== 'number') {
          errors.push({
            file: configPath,
            errors: [`env key "${key}" must be a string, got ${typeof value}`],
            warnings: [],
          });
          return empty;
        }
        config.env[key] = String(value);
      }
    }

    return config;
  }

  return empty;
}
