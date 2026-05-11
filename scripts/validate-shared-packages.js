#!/usr/bin/env node
/**
 * Validates that all shared packages are consistently wired into the
 * build/publish pipeline. Catches the case where a new shared/ package is
 * added but one of the packaging scripts is not updated.
 *
 * Usage: node scripts/validate-shared-packages.js
 */
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const sharedDir = path.join(repoRoot, 'shared');

const canonical = fs
  .readdirSync(sharedDir, { withFileTypes: true })
  .filter(
    (e) =>
      e.isDirectory() &&
      e.name !== 'prisma' &&
      fs.existsSync(path.join(sharedDir, e.name, 'package.json')),
  )
  .map((e) => e.name)
  .sort();

const errors = [];

// 1. publish-package.json should NOT hardcode shared package entries
//    (they are injected dynamically by collect-deps.js)
const template = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, 'scripts', 'publish-package.json'),
    'utf-8',
  ),
);
for (const pkg of canonical) {
  const hardcoded = (template.files || []).filter((f) =>
    f.startsWith(`shared/${pkg}/`),
  );
  if (hardcoded.length > 0) {
    errors.push(
      `publish-package.json hardcodes shared/${pkg} — these should be injected by collect-deps.js`,
    );
  }
}

// 2. build-package.sh should NOT contain a hardcoded "for pkg in ..." list
const buildSh = fs.readFileSync(
  path.join(repoRoot, 'scripts', 'build-package.sh'),
  'utf-8',
);
if (/for pkg in\s+[a-z]/.test(buildSh)) {
  errors.push(
    'build-package.sh contains a hardcoded "for pkg in ..." list — use dynamic discovery',
  );
}

// 3. postinstall.js should NOT contain a hardcoded internalPackages array
const postinstall = fs.readFileSync(
  path.join(repoRoot, 'scripts', 'postinstall.js'),
  'utf-8',
);
if (/internalPackages\s*=\s*\[/.test(postinstall)) {
  errors.push(
    'postinstall.js contains a hardcoded internalPackages array — use dynamic discovery',
  );
}

// 4. sync-version.sh should NOT hardcode shared/ entries in PACKAGE_FILES
const syncSh = fs.readFileSync(
  path.join(repoRoot, 'scripts', 'sync-version.sh'),
  'utf-8',
);
for (const pkg of canonical) {
  if (syncSh.includes(`"shared/${pkg}/package.json"`)) {
    const context = syncSh.substring(
      syncSh.indexOf(`"shared/${pkg}/package.json"`) - 50,
      syncSh.indexOf(`"shared/${pkg}/package.json"`) + 40,
    );
    // Only flag if it's inside the PACKAGE_FILES array, not in a comment
    if (!context.includes('#')) {
      errors.push(
        `sync-version.sh hardcodes shared/${pkg}/package.json — use dynamic discovery`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error('Shared package validation failed:\n');
  for (const err of errors) {
    console.error(`  ✗ ${err}`);
  }
  console.error('');
  process.exit(1);
}

console.log(
  `✓ All ${canonical.length} shared packages are dynamically discovered: ${canonical.join(', ')}`,
);
