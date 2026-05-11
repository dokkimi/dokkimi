import * as fs from 'fs';
import * as os from 'os';
import * as yaml from 'js-yaml';
import { execSilent } from '@dokkimi/platform';

jest.mock('fs');
jest.mock('os');
jest.mock('js-yaml');
jest.mock('@dokkimi/platform');

const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedOs = os as jest.Mocked<typeof os>;
const mockedYaml = yaml as jest.Mocked<typeof yaml>;
const mockedExecSilent = execSilent as jest.MockedFunction<typeof execSilent>;

// We need to re-import after mocks are set up
let resolveRegistryCredentials: () => import('@dokkimi/config').RegistryCredential[];

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('./registry-credentials');
  resolveRegistryCredentials = mod.resolveRegistryCredentials;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedOs.homedir.mockReturnValue('/home/testuser');
  jest.spyOn(process, 'cwd').mockReturnValue('/projects/my-app');
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helper: configure fs.existsSync responses
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function mockExistsSync(pathMap: Record<string, boolean>) {
  mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
    const pathStr = String(p);
    for (const [key, value] of Object.entries(pathMap)) {
      if (pathStr === key || pathStr.endsWith(key)) {
        return value;
      }
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// registries.yaml path
// ---------------------------------------------------------------------------

describe('resolveRegistryCredentials — registries.yaml', () => {
  it('reads and parses YAML when registries.yaml exists', () => {
    // The finder walks up from cwd. Let the first candidate match.
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      return String(p) === '/projects/my-app/.dokkimi/registries.yaml';
    });
    mockedFs.readFileSync.mockReturnValue('raw-yaml');
    mockedYaml.load.mockReturnValue({
      registries: [
        {
          registryUrl: 'ghcr.io',
          username: 'user1',
          password: 'pass1',
        },
      ],
    });

    const result = resolveRegistryCredentials();
    expect(mockedFs.readFileSync).toHaveBeenCalledWith(
      '/projects/my-app/.dokkimi/registries.yaml',
      'utf-8',
    );
    expect(result).toEqual([
      { registryUrl: 'ghcr.io', username: 'user1', password: 'pass1' },
    ]);
  });

  it('resolves ${ENV_VAR} from process.env', () => {
    process.env.REGISTRY_USER = 'envuser';
    process.env.REGISTRY_PASS = 'envpass';

    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      return String(p) === '/projects/my-app/.dokkimi/registries.yaml';
    });
    mockedFs.readFileSync.mockReturnValue('raw-yaml');
    mockedYaml.load.mockReturnValue({
      registries: [
        {
          registryUrl: 'ghcr.io',
          username: '${REGISTRY_USER}',
          password: '${REGISTRY_PASS}',
        },
      ],
    });

    const result = resolveRegistryCredentials();
    expect(result[0].username).toBe('envuser');
    expect(result[0].password).toBe('envpass');

    delete process.env.REGISTRY_USER;
    delete process.env.REGISTRY_PASS;
  });

  it('throws on missing env var', () => {
    delete process.env.NONEXISTENT_VAR;

    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      return String(p) === '/projects/my-app/.dokkimi/registries.yaml';
    });
    mockedFs.readFileSync.mockReturnValue('raw-yaml');
    mockedYaml.load.mockReturnValue({
      registries: [
        {
          registryUrl: 'ghcr.io',
          username: '${NONEXISTENT_VAR}',
          password: 'fixed',
        },
      ],
    });

    expect(() => resolveRegistryCredentials()).toThrow(
      /NONEXISTENT_VAR.*is not set/,
    );
  });
});

// ---------------------------------------------------------------------------
// Docker config path
// ---------------------------------------------------------------------------

describe('resolveRegistryCredentials — Docker config', () => {
  beforeEach(() => {
    // No registries.yaml anywhere
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const pathStr = String(p);
      if (pathStr.includes('registries.yaml')) {
        return false;
      }
      // Docker config exists
      if (pathStr === '/home/testuser/.docker/config.json') {
        return true;
      }
      return false;
    });
  });

  it('reads inline auths and decodes base64', () => {
    const encoded = Buffer.from('myuser:mypass').toString('base64');
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        auths: {
          'https://ghcr.io': { auth: encoded },
        },
      }),
    );

    const result = resolveRegistryCredentials();
    expect(result).toEqual([
      { registryUrl: 'ghcr.io', username: 'myuser', password: 'mypass' },
    ]);
  });

  it('handles credsStore — calls docker-credential-<store> list then get', () => {
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        credsStore: 'desktop',
      }),
    );

    mockedExecSilent.mockImplementation((cmd: string, _opts?: any) => {
      if (cmd === 'docker-credential-desktop list') {
        return JSON.stringify({ 'https://registry.example.com': 'user' });
      }
      if (cmd === 'docker-credential-desktop get') {
        return JSON.stringify({ Username: 'storeuser', Secret: 'storepass' });
      }
      return '';
    });

    const result = resolveRegistryCredentials();
    expect(mockedExecSilent).toHaveBeenCalledWith(
      'docker-credential-desktop list',
      { timeout: 10000 },
    );
    expect(mockedExecSilent).toHaveBeenCalledWith(
      'docker-credential-desktop get',
      { input: 'https://registry.example.com', timeout: 10000 },
    );
    expect(result).toHaveLength(1);
    expect(result[0].username).toBe('storeuser');
    expect(result[0].password).toBe('storepass');
  });

  it('handles credHelpers — calls docker-credential-<helper> get per registry', () => {
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        credHelpers: {
          'gcr.io': 'gcloud',
        },
      }),
    );

    mockedExecSilent.mockImplementation((cmd: string, _opts?: any) => {
      if (cmd === 'docker-credential-gcloud get') {
        return JSON.stringify({ Username: 'guser', Secret: 'gsecret' });
      }
      return '';
    });

    const result = resolveRegistryCredentials();
    expect(mockedExecSilent).toHaveBeenCalledWith(
      'docker-credential-gcloud get',
      { input: 'gcr.io', timeout: 10000 },
    );
    expect(result).toEqual([
      { registryUrl: 'gcr.io', username: 'guser', password: 'gsecret' },
    ]);
  });

  it('credHelpers override auths override credsStore for same registry', () => {
    const authEncoded = Buffer.from('authuser:authpass').toString('base64');

    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        credsStore: 'desktop',
        auths: {
          'https://gcr.io': { auth: authEncoded },
        },
        credHelpers: {
          'gcr.io': 'gcloud',
        },
      }),
    );

    mockedExecSilent.mockImplementation((cmd: string, _opts?: any) => {
      if (cmd === 'docker-credential-desktop list') {
        return JSON.stringify({ 'https://gcr.io': 'storeuser' });
      }
      if (cmd === 'docker-credential-desktop get') {
        return JSON.stringify({ Username: 'storeuser', Secret: 'storepass' });
      }
      if (cmd === 'docker-credential-gcloud get') {
        return JSON.stringify({ Username: 'helperuser', Secret: 'helperpass' });
      }
      return '';
    });

    const result = resolveRegistryCredentials();
    // credHelpers wins for gcr.io
    const gcrCred = result.find((c) => c.registryUrl === 'gcr.io');
    expect(gcrCred).toBeDefined();
    expect(gcrCred!.username).toBe('helperuser');
    expect(gcrCred!.password).toBe('helperpass');
  });

  it('strips https:// from registry URLs but keeps index.docker.io', () => {
    const encoded = Buffer.from('u:p').toString('base64');
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        auths: {
          'https://ghcr.io': { auth: encoded },
          'https://index.docker.io/v1/': { auth: encoded },
        },
      }),
    );

    const result = resolveRegistryCredentials();
    const urls = result.map((c) => c.registryUrl);
    expect(urls).toContain('ghcr.io');
    expect(urls).toContain('https://index.docker.io/v1/');
  });

  it('returns empty array when no sources found', () => {
    // No registries.yaml and no Docker config
    mockedFs.existsSync.mockReturnValue(false);
    const result = resolveRegistryCredentials();
    expect(result).toEqual([]);
  });

  it('handles malformed Docker config JSON gracefully', () => {
    mockedFs.readFileSync.mockReturnValue('not valid json {{{');
    const result = resolveRegistryCredentials();
    expect(result).toEqual([]);
  });

  it('skips auths entries without auth field', () => {
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        auths: {
          'https://ghcr.io': {},
        },
      }),
    );

    const result = resolveRegistryCredentials();
    expect(result).toEqual([]);
  });
});
