#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pkgRoot = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// 1. Symlink internal @dokkimi/* packages into node_modules so that the
//    compiled JS (which requires('@dokkimi/config') etc.) can resolve them.
//    In the monorepo, yarn workspaces does this automatically. In the
//    published flat package we have to do it ourselves.
// ---------------------------------------------------------------------------
const sharedDir = path.join(pkgRoot, 'shared');
const internalPackages = fs
  .readdirSync(sharedDir, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() &&
      entry.name !== 'prisma' &&
      fs.existsSync(path.join(sharedDir, entry.name, 'package.json')),
  )
  .map((entry) => ({
    name: entry.name,
    dir: path.join(sharedDir, entry.name),
  }));

const dokkimiScope = path.join(pkgRoot, 'node_modules', '@dokkimi');
if (!fs.existsSync(dokkimiScope)) {
  fs.mkdirSync(dokkimiScope, { recursive: true });
}

for (const { name, dir } of internalPackages) {
  const linkPath = path.join(dokkimiScope, name);
  if (fs.existsSync(linkPath)) {
    continue;
  } // already linked (re-install)
  try {
    fs.symlinkSync(dir, linkPath, 'junction');
  } catch (err) {
    console.error(
      `Warning: failed to symlink @dokkimi/${name}: ${err.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Generate the Prisma client (needed before the services can start).
// ---------------------------------------------------------------------------
const schemaPath = path.join(
  pkgRoot,
  'shared',
  'prisma',
  'sqlite',
  'schema.prisma',
);
const prismaBin = path.join(pkgRoot, 'node_modules', '.bin', 'prisma');

try {
  execSync(`"${prismaBin}" generate --schema="${schemaPath}"`, {
    stdio: 'inherit',
    cwd: pkgRoot,
  });
} catch (err) {
  console.error(
    'Warning: Prisma client generation failed. Run "npx prisma generate" manually.',
  );
  console.error(err.message);
  // Don't exit with error — let the install succeed. Prisma will fail at runtime with a clear message.
}

// ---------------------------------------------------------------------------
// 3. Apply database migrations so the app DB is ready before the first
//    `dokkimi run`. Doing this at install time is better than at runtime —
//    the user is already waiting, has network available, and install-time
//    failures are visible and actionable. The runtime code in
//    service-manager will also attempt migration as a fallback.
//
//    The DB path matches config/config.yaml (file:~/.dokkimi/dokkimi.db).
//    os.homedir() resolves to the installing user's home — npm drops root
//    privileges for lifecycle scripts when the package dir isn't owned by
//    root, so this normally matches the user who will run `dokkimi`.
// ---------------------------------------------------------------------------
const dbPath = path.join(os.homedir(), '.dokkimi', 'dokkimi.db');
// Prisma v7 requires the datasource URL to come from prisma.config.ts (the
// schema file is no longer allowed to contain `url`). Point the CLI at the
// config we ship inside the package.
const configPath = path.join(pkgRoot, 'shared', 'prisma', 'prisma.config.ts');
try {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  execSync(`"${prismaBin}" migrate deploy --config="${configPath}"`, {
    stdio: 'inherit',
    cwd: pkgRoot,
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    timeout: 120000,
  });
} catch (err) {
  console.error(
    'Warning: Prisma migrations failed during install. Dokkimi will retry on first `dokkimi run`.',
  );
  console.error(err.message || String(err));
  // Don't fail the install — the runtime migration in service-manager will retry.
}

// ---------------------------------------------------------------------------
// 4. Register LLM context (dokkimi-instructions.md + pointers in global
//    AI config files). This way users get AI assistance for .dokkimi/ files
//    immediately after install, without needing to run a CLI command first.
// ---------------------------------------------------------------------------
try {
  require(
    path.join(pkgRoot, 'apps', 'cli', 'dist', 'lib', 'llm-context-register.js'),
  ).registerLlmContext();
} catch {
  // Non-critical — the CLI will retry on first invocation.
}
