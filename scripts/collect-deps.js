#!/usr/bin/env node
/**
 * Collects production dependencies from all package.json files in the staging
 * directory, merges them into the publish-package.json template, and writes
 * the result to stdout.
 *
 * Usage: node scripts/collect-deps.js <staging-dir>
 */
const fs = require('fs');
const path = require('path');

const stageDir = process.argv[2];
if (!stageDir) {
  console.error('Usage: node scripts/collect-deps.js <staging-dir>');
  process.exit(1);
}

const templatePath = path.join(__dirname, 'publish-package.json');
const template = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));

// Dynamically add shared packages to the files list
const repoSharedDir = path.join(__dirname, '..', 'shared');
const sharedPkgs = fs
  .readdirSync(repoSharedDir, { withFileTypes: true })
  .filter(
    (e) =>
      e.isDirectory() &&
      e.name !== 'prisma' &&
      fs.existsSync(path.join(repoSharedDir, e.name, 'package.json')),
  )
  .map((e) => e.name)
  .sort();

for (const pkg of sharedPkgs) {
  template.files.push(`shared/${pkg}/dist/`, `shared/${pkg}/package.json`);
}

// Collect all package.json files in the staging directory (services/ and shared/)
const dirs = [
  ...fs
    .readdirSync(path.join(stageDir, 'services'))
    .map((d) => path.join(stageDir, 'services', d)),
  ...fs
    .readdirSync(path.join(stageDir, 'shared'))
    .filter((d) =>
      fs.existsSync(path.join(stageDir, 'shared', d, 'package.json')),
    )
    .map((d) => path.join(stageDir, 'shared', d)),
];

// Also include apps (read from repo, not staging — only dist/ is copied)
const repoRoot = path.join(__dirname, '..');
for (const app of ['cli', 'mcp']) {
  const appPkgPath = path.join(repoRoot, 'apps', app, 'package.json');
  if (fs.existsSync(appPkgPath)) {
    dirs.push(path.dirname(appPkgPath));
  }
}

const merged = {};

for (const dir of dirs) {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    continue;
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const deps = pkg.dependencies || {};

  for (const [name, version] of Object.entries(deps)) {
    // Skip workspace references — these are internal packages included in the bundle
    if (typeof version === 'string' && version.startsWith('workspace:')) {
      continue;
    }

    // If we already have this dep, keep the higher version
    if (merged[name]) {
      const existing = merged[name].replace(/^\^|~/, '');
      const incoming = version.replace(/^\^|~/, '');
      // Simple semver comparison: split on dots and compare numerically
      const eParts = existing.split('.').map(Number);
      const iParts = incoming.split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        if ((iParts[i] || 0) > (eParts[i] || 0)) {
          merged[name] = version;
          break;
        }
        if ((iParts[i] || 0) < (eParts[i] || 0)) {
          break;
        }
      }
    } else {
      merged[name] = version;
    }
  }
}

// Ensure prisma is included (needed by postinstall and runtime migration)
if (!merged['prisma']) {
  merged['prisma'] = '^7.0.0';
}

// Sort dependencies alphabetically
const sorted = {};
for (const key of Object.keys(merged).sort()) {
  sorted[key] = merged[key];
}

// Read version from repo root VERSION file if it exists
const versionFile = path.join(__dirname, '..', 'VERSION');
if (fs.existsSync(versionFile)) {
  const version = fs.readFileSync(versionFile, 'utf-8').trim();
  if (version) {
    template.version = version;
  }
}

template.dependencies = sorted;

process.stdout.write(JSON.stringify(template, null, 2) + '\n');
