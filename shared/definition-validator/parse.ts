import yaml from 'js-yaml';

const DEFINITION_EXTENSIONS = ['.json', '.yml', '.yaml'];

/**
 * Returns true if the file path has a supported definition extension.
 */
export function isDefinitionFile(filePath: string): boolean {
  return DEFINITION_EXTENSIONS.some((ext) => filePath.endsWith(ext));
}

/**
 * Parses a definition file (JSON or YAML) based on its extension.
 */
export function parseDefinitionFile(filePath: string, raw: string): unknown {
  if (filePath.endsWith('.yml') || filePath.endsWith('.yaml')) {
    return yaml.load(raw);
  }
  return JSON.parse(raw);
}
