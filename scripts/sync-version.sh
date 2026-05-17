#!/bin/bash

# Reads the VERSION file and updates all package.json files in the monorepo to match.
# Usage: ./scripts/sync-version.sh

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=$(cat "$REPO_ROOT/VERSION" | tr -d '[:space:]')

if [ -z "$VERSION" ]; then
  echo "ERROR: VERSION file is empty or missing"
  exit 1
fi

echo "Syncing all package.json files to version ${VERSION}..."

PACKAGE_FILES=(
  "package.json"
  "apps/cli/package.json"
  "apps/mcp/package.json"
  "apps/landing/package.json"
  "apps/vscode/package.json"
  "services/control-tower/package.json"
)

# Dynamically add shared packages (prisma has no version field to sync)
for pkg_dir in "$REPO_ROOT"/shared/*/; do
  pkg="$(basename "$pkg_dir")"
  [ "$pkg" = "prisma" ] && continue
  [ ! -f "$REPO_ROOT/shared/$pkg/package.json" ] && continue
  PACKAGE_FILES+=("shared/$pkg/package.json")
done

for file in "${PACKAGE_FILES[@]}"; do
  filepath="$REPO_ROOT/$file"
  if [ -f "$filepath" ]; then
    # Use node to update the version field in-place
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('$filepath', 'utf8'));
      pkg.version = '$VERSION';
      fs.writeFileSync('$filepath', JSON.stringify(pkg, null, 2) + '\n');
    "
    echo "  ✓ $file"
  else
    echo "  ✗ $file (not found)"
  fi
done

echo ""
echo "All package.json files synced to version ${VERSION}"
