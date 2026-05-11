import * as path from 'path';
import * as fs from 'fs';
import { prompt } from '../lib/cli-utils';
import { getCliVersion } from '../lib/version';

const EXAMPLE_DEFINITION = `# Example definition — replace with your own services and tests
name: example-test
description: Example definition — replace with your own services and tests
config:
  timeoutSeconds: 300
items:
  - type: SERVICE
    name: my-service
    image: my-service:latest
    port: 3000
    healthCheck: /health
tests:
  - name: Health Check
    steps:
      - - name: Verify service is healthy
          action:
            type: httpRequest
            method: GET
            url: my-service/health
          assertions:
            - assertions:
                - { path: response.status, operator: eq, value: 200 }
`;

const EXAMPLE_FRAGMENT = `# Shared PostgreSQL database — reference with $ref from definitions
type: DATABASE
name: postgres-db
description: Shared PostgreSQL database — reference with $ref from definitions
database: postgres
initFilePath: ../init-files/init.sql
`;

const EXAMPLE_INIT_SQL = `-- Example init file for PostgreSQL
-- This runs when the database starts

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO users (email, name) VALUES
  ('alice@example.com', 'Alice'),
  ('bob@example.com', 'Bob');
`;

export async function init(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: dokkimi init');
    console.log('');
    console.log(
      'Scaffolds a .dokkimi/ folder in the current directory with example files.',
    );
    process.exit(0);
  }

  const rootPath = process.cwd();
  const dokkimiDir = path.join(rootPath, '.dokkimi');

  if (fs.existsSync(dokkimiDir)) {
    const answer = await prompt(
      '.dokkimi/ folder already exists. Overwrite starter files? (y/n) ',
    );
    if (answer !== 'y' && answer !== 'yes') {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  const dirs = [
    path.join(dokkimiDir, 'definitions'),
    path.join(dokkimiDir, 'shared'),
    path.join(dokkimiDir, 'init-files'),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const cliVersion = getCliVersion();
  const configContent = `dokkimi: ${cliVersion}\nenv: {}\n`;

  const files = [
    {
      filePath: path.join(dokkimiDir, 'config.yaml'),
      content: configContent,
    },
    {
      filePath: path.join(dokkimiDir, 'definitions', 'example.yaml'),
      content: EXAMPLE_DEFINITION,
    },
    {
      filePath: path.join(dokkimiDir, 'shared', 'postgres.yaml'),
      content: EXAMPLE_FRAGMENT,
    },
    {
      filePath: path.join(dokkimiDir, 'init-files', 'init.sql'),
      content: EXAMPLE_INIT_SQL,
    },
  ];

  for (const file of files) {
    fs.writeFileSync(file.filePath, file.content, 'utf-8');
  }

  console.log(
    'Created .dokkimi/ with example files. Edit definitions/ to get started.',
  );
}
