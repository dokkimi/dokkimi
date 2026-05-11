import * as os from 'node:os';
import * as path from 'node:path';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: path.join(__dirname, 'sqlite', 'schema.prisma'),
  migrations: {
    path: path.join(__dirname, 'migrations'),
  },
  datasource: {
    url:
      process.env.DATABASE_URL ||
      `file:${path.join(os.homedir(), '.dokkimi', 'dokkimi.db')}`,
  },
});
