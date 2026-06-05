import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DOKKIMI_VERSION } from '@dokkimi/config';

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

export function registerInit(server: McpServer): void {
  server.tool(
    'init',
    'Scaffolds a .dokkimi/ folder with example definition files in the current working directory. Use this to set up Dokkimi in a new project. If .dokkimi/ already exists, pass force: true to overwrite the starter files.',
    {
      force: z
        .boolean()
        .optional()
        .describe(
          'Overwrite existing .dokkimi/ starter files if the folder already exists. Defaults to false.',
        ),
    },
    async ({ force }) => {
      const rootPath = process.cwd();
      const dokkimiDir = path.join(rootPath, '.dokkimi');

      if (fs.existsSync(dokkimiDir) && !force) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  error:
                    '.dokkimi/ folder already exists. Pass force: true to overwrite starter files.',
                  path: dokkimiDir,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      const dirs = [
        path.join(dokkimiDir, 'definitions'),
        path.join(dokkimiDir, 'shared'),
        path.join(dokkimiDir, 'init-files'),
      ];

      for (const dir of dirs) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const configContent = `dokkimi: ${DOKKIMI_VERSION}\nenv: {}\n`;

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

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                path: dokkimiDir,
                filesCreated: files.map((f) =>
                  path.relative(rootPath, f.filePath),
                ),
                nextSteps: [
                  'Edit .dokkimi/definitions/example.yaml to define your services and tests',
                  'Add shared fragments in .dokkimi/shared/',
                  'Run validate_file to check your definitions',
                  'Run run_tests to execute your test suite',
                ],
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
