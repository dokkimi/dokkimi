import * as os from 'os';
import * as path from 'path';

const configPath = path.join(__dirname, '../../config/config.yaml');

function databaseUrl(env: Record<string, string>): string {
  const saved = { ...process.env };
  delete process.env.DATABASE_URL;
  delete process.env.DOKKIMI_DATABASE_URL;
  Object.assign(process.env, env);
  let url = '';
  try {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ConfigLoader } = require('./config.loader');
      url = ConfigLoader.getInstance().load(configPath).database.url;
    });
  } finally {
    process.env = saved;
  }
  return url;
}

// Dokkimi runs in the user's shell, where generic names are often set for
// their own app. Only DOKKIMI_ names change Dokkimi's own settings.
describe('environment variable names', () => {
  it("ignores DATABASE_URL, the user's app database", () => {
    expect(databaseUrl({ DATABASE_URL: 'postgres://app/db' })).toBe(
      `file:${path.join(os.homedir(), '.dokkimi', 'dokkimi.db')}`,
    );
  });

  it('uses DOKKIMI_DATABASE_URL', () => {
    expect(databaseUrl({ DOKKIMI_DATABASE_URL: 'postgres://ct/db' })).toBe(
      'postgres://ct/db',
    );
  });
});
