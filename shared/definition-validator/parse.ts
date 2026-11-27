import yaml from 'js-yaml';

const DEFINITION_EXTENSIONS = ['.json', '.yml', '.yaml'];

// YAML merge keys (`<<: *base`) are common for sharing parts of a definition;
// js-yaml's default schema leaves them out
const YAML_SCHEMA = yaml.CORE_SCHEMA.withTags(yaml.mergeTag);

/**
 * Returns true if the file path has a supported definition extension.
 */
export function isDefinitionFile(filePath: string): boolean {
  return DEFINITION_EXTENSIONS.some((ext) => filePath.endsWith(ext));
}

/**
 * Parses a definition file (JSON or YAML) based on its extension. A file
 * with nothing but whitespace and comments (e.g. work in progress) is
 * undefined: not a definition, rather than a parse error.
 */
export function parseDefinitionFile(filePath: string, raw: string): unknown {
  if (filePath.endsWith('.yml') || filePath.endsWith('.yaml')) {
    if (raw.split('\n').every((line) => /^\s*(#.*)?$/.test(line))) {
      return undefined;
    }
    return yaml.load(raw, { schema: YAML_SCHEMA });
  }
  if (raw.trim() === '') {
    return undefined;
  }
  return JSON.parse(raw);
}
