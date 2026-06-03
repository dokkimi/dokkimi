import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import { execSilent } from '@dokkimi/platform';
import { RegistryCredential } from '@dokkimi/config';

export type { RegistryCredential };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolves registry credentials from the best available source.
 *
 * Resolution order:
 * 1. .dokkimi/registries.yaml (explicit config wins)
 * 2. ~/.docker/config.json (automatic, local)
 * 3. Empty array (public images only)
 */
export function resolveRegistryCredentials(): RegistryCredential[] {
  const registriesPath = findRegistriesYaml();
  if (registriesPath) {
    return resolveFromRegistriesYaml(registriesPath);
  }

  return resolveFromDockerConfig();
}

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

/**
 * Normalizes a registry URL to a hostname for image matching.
 * Docker credential helpers return URLs with https:// prefix, but
 * image references use plain hostnames. Docker Hub's special URL is
 * kept as-is since Docker recognizes it.
 */
function normalizeRegistryUrl(url: string): string {
  // Keep Docker Hub's canonical URL as-is
  if (url.includes('index.docker.io')) {
    return url;
  }
  // Strip scheme prefix
  return url.replace(/^https?:\/\//, '');
}

// ---------------------------------------------------------------------------
// registries.yaml resolution
// ---------------------------------------------------------------------------

function findRegistriesYaml(): string | null {
  // Walk up from cwd looking for .dokkimi/registries.yaml
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, '.dokkimi', 'registries.yaml');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

interface RegistriesYaml {
  registries?: Array<{
    registryUrl?: string;
    username?: string;
    password?: string;
  }>;
}

function resolveFromRegistriesYaml(filePath: string): RegistryCredential[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = yaml.load(raw) as RegistriesYaml;

  if (!parsed?.registries || !Array.isArray(parsed.registries)) {
    return [];
  }

  return parsed.registries.map((entry) => {
    const registryUrl = resolveEnvVars(entry.registryUrl ?? '');
    const username = resolveEnvVars(entry.username ?? '');
    const password = resolveEnvVars(entry.password ?? '');

    return { registryUrl, username, password };
  });
}

/**
 * Resolves ${VAR} references from process.env.
 * Throws on unresolvable variables.
 */
function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, varName: string) => {
    const resolved = process.env[varName];
    if (resolved === undefined) {
      throw new Error(
        `Registry credential variable \${${varName}} is not set. Set it in your environment before running.`,
      );
    }
    return resolved;
  });
}

// ---------------------------------------------------------------------------
// Docker config resolution
// ---------------------------------------------------------------------------

interface DockerConfig {
  auths?: Record<string, { auth?: string }>;
  credsStore?: string;
  credHelpers?: Record<string, string>;
}

function resolveFromDockerConfig(): RegistryCredential[] {
  const configPath = path.join(os.homedir(), '.docker', 'config.json');
  if (!fs.existsSync(configPath)) {
    return [];
  }

  let config: DockerConfig;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as DockerConfig;
  } catch {
    return [];
  }

  const credentials = new Map<string, RegistryCredential>();

  // 1. credsStore (lowest priority — overridden by auths and credHelpers)
  if (config.credsStore) {
    const storeCreds = resolveCredStore(config.credsStore);
    for (const cred of storeCreds) {
      credentials.set(normalizeRegistryUrl(cred.registryUrl), cred);
    }
  }

  // 2. Inline auths (override credsStore for same registry)
  if (config.auths) {
    for (const [registry, entry] of Object.entries(config.auths)) {
      if (!entry.auth) {
        continue;
      }
      const decoded = decodeAuth(entry.auth);
      if (decoded) {
        const normalized = normalizeRegistryUrl(registry);
        credentials.set(normalized, {
          registryUrl: normalized,
          username: decoded.username,
          password: decoded.password,
        });
      }
    }
  }

  // 3. credHelpers (highest priority — override both credsStore and auths)
  if (config.credHelpers) {
    for (const [registry, helper] of Object.entries(config.credHelpers)) {
      const cred = resolveCredHelper(helper, registry);
      if (cred) {
        credentials.set(normalizeRegistryUrl(registry), cred);
      }
    }
  }

  return Array.from(credentials.values());
}

function decodeAuth(
  auth: string,
): { username: string; password: string } | null {
  try {
    const decoded = Buffer.from(auth, 'base64').toString('utf-8');
    const colonIndex = decoded.indexOf(':');
    if (colonIndex === -1) {
      return null;
    }
    return {
      username: decoded.substring(0, colonIndex),
      password: decoded.substring(colonIndex + 1),
    };
  } catch {
    return null;
  }
}

/**
 * Resolves all credentials from a credential store (e.g. "desktop", "osxkeychain").
 * Shells out to docker-credential-<store>.
 */
function resolveCredStore(store: string): RegistryCredential[] {
  const helper = `docker-credential-${store}`;
  const credentials: RegistryCredential[] = [];

  let registries: string[];
  try {
    const output = execSilent(`${helper} list`, { timeout: 10000 });
    const parsed = JSON.parse(output) as Record<string, string>;
    registries = Object.keys(parsed);
  } catch {
    console.warn(
      `\x1b[33mWarning: Could not list credentials from ${helper}. Skipping.\x1b[0m`,
    );
    return [];
  }

  for (const registry of registries) {
    const cred = resolveCredHelper(store, registry);
    if (cred) {
      credentials.push(cred);
    }
  }

  return credentials;
}

/**
 * Resolves a single credential from a credential helper.
 * Shells out to docker-credential-<helper> get.
 */
function resolveCredHelper(
  helper: string,
  registry: string,
): RegistryCredential | null {
  const helperBin = `docker-credential-${helper}`;
  try {
    const output = execSilent(`${helperBin} get`, {
      input: registry,
      timeout: 10000,
    });
    const parsed = JSON.parse(output) as {
      Username?: string;
      Secret?: string;
    };
    if (parsed.Username && parsed.Secret) {
      return {
        registryUrl: normalizeRegistryUrl(registry),
        username: parsed.Username,
        password: parsed.Secret,
      };
    }
  } catch {
    // Helper not found or failed for this registry — skip silently
  }
  return null;
}
