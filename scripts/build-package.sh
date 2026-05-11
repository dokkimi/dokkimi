#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE_DIR="$REPO_ROOT/.publish-staging"
CURRENT_VERSION=$(cat "$REPO_ROOT/VERSION" | tr -d '[:space:]')

echo ""
echo "  Current version: $CURRENT_VERSION"
echo ""
echo "  How do you want to version this build?"
echo ""
echo "    1) Patch  ($(echo "$CURRENT_VERSION" | awk -F. '{printf "%s.%s.%s", $1, $2, $3+1}'))"
echo "    2) Minor  ($(echo "$CURRENT_VERSION" | awk -F. '{printf "%s.%s.0", $1, $2+1}'))"
echo "    3) Major  ($(echo "$CURRENT_VERSION" | awk -F. '{printf "%s.0.0", $1+1}'))"
echo "    4) Keep   ($CURRENT_VERSION)"
echo "    5) Custom"
echo ""
read -p "  Choice [1-5]: " choice

case "$choice" in
  1)
    NEW_VERSION=$(echo "$CURRENT_VERSION" | awk -F. '{printf "%s.%s.%s", $1, $2, $3+1}')
    ;;
  2)
    NEW_VERSION=$(echo "$CURRENT_VERSION" | awk -F. '{printf "%s.%s.0", $1, $2+1}')
    ;;
  3)
    NEW_VERSION=$(echo "$CURRENT_VERSION" | awk -F. '{printf "%s.0.0", $1+1}')
    ;;
  4)
    NEW_VERSION="$CURRENT_VERSION"
    ;;
  5)
    read -p "  Enter version: " NEW_VERSION
    if ! echo "$NEW_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
      echo "  Invalid version format. Must be X.Y.Z"
      exit 1
    fi
    ;;
  *)
    echo "  Invalid choice"
    exit 1
    ;;
esac

if [ "$NEW_VERSION" != "$CURRENT_VERSION" ]; then
  echo ""
  echo "==> Updating version: $CURRENT_VERSION -> $NEW_VERSION"
  echo "$NEW_VERSION" > "$REPO_ROOT/VERSION"
  "$REPO_ROOT/scripts/sync-version.sh"
fi

echo ""
echo "==> Cleaning staging directory"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

echo "==> Building all packages"
cd "$REPO_ROOT"
yarn build:shared
yarn build:services

echo "==> Building CLI"
yarn workspace @dokkimi/cli build

echo "==> Assembling package"

# Copy compiled outputs (strip devDependencies and scripts from package.json)
strip_dev_deps() {
  node -e "
    const pkg = require('$1');
    delete pkg.devDependencies;
    delete pkg.scripts;
    process.stdout.write(JSON.stringify(pkg, null, 2) + '\n');
  " > "$2"
}

for pkg_dir in shared/*/; do
  pkg="$(basename "$pkg_dir")"
  [ "$pkg" = "prisma" ] && continue
  [ ! -f "shared/$pkg/package.json" ] && continue
  mkdir -p "$STAGE_DIR/shared/$pkg"
  cp -r "shared/$pkg/dist" "$STAGE_DIR/shared/$pkg/dist"
  strip_dev_deps "$REPO_ROOT/shared/$pkg/package.json" "$STAGE_DIR/shared/$pkg/package.json"
done

# Prisma schema + migrations
mkdir -p "$STAGE_DIR/shared/prisma"
mkdir -p "$STAGE_DIR/shared/prisma/sqlite"
cp shared/prisma/sqlite/schema.prisma "$STAGE_DIR/shared/prisma/sqlite/"
cp shared/prisma/prisma.config.ts "$STAGE_DIR/shared/prisma/"
cp -r shared/prisma/migrations "$STAGE_DIR/shared/prisma/migrations"

# Shared docs
mkdir -p "$STAGE_DIR/shared/docs"
cp shared/docs/dokkimi-instructions.md "$STAGE_DIR/shared/docs/"

# Control Tower (compiled + stripped package.json)
mkdir -p "$STAGE_DIR/services/control-tower"
cp -r services/control-tower/dist "$STAGE_DIR/services/control-tower/dist"
strip_dev_deps "$REPO_ROOT/services/control-tower/package.json" "$STAGE_DIR/services/control-tower/package.json"

# CLI
mkdir -p "$STAGE_DIR/apps/cli"
cp -r apps/cli/dist "$STAGE_DIR/apps/cli/dist"

# Ensure shebang on CLI entry point (tsc may strip it)
CLI_ENTRY="$STAGE_DIR/apps/cli/dist/bin/dokkimi.js"
if ! head -1 "$CLI_ENTRY" | grep -q '^#!/'; then
  printf '#!/usr/bin/env node\n' | cat - "$CLI_ENTRY" > "$CLI_ENTRY.tmp"
  mv "$CLI_ENTRY.tmp" "$CLI_ENTRY"
fi
chmod +x "$CLI_ENTRY"

# Config (inject PostHog telemetry key for published builds)
mkdir -p "$STAGE_DIR/config"
cp config/config.yaml "$STAGE_DIR/config/config.yaml"
sed -i '' \
  -e 's|posthogApiKey:.*|posthogApiKey: phc_qRHhgna4UJzsZ47Vr3yf4aRQ4mSD9ykqyN5kDtoigSJp|' \
  "$STAGE_DIR/config/config.yaml"

# Postinstall script
mkdir -p "$STAGE_DIR/scripts"
cp scripts/postinstall.js "$STAGE_DIR/scripts/"

# npm package README + LICENSE
cp scripts/npm-readme.md "$STAGE_DIR/README.md"
cp "$REPO_ROOT/LICENSE" "$STAGE_DIR/LICENSE"

# Generate publish package.json with auto-collected dependencies
echo "==> Collecting production dependencies"
node scripts/collect-deps.js "$STAGE_DIR" > "$STAGE_DIR/package.json"

echo "==> Installing production dependencies"
cd "$STAGE_DIR"
npm install --omit=dev

BUILT_VERSION=$(node -e "console.log(require('./package.json').version)")

# Update Homebrew formula (url + sha256) from the staged tarball.
# npm publish uploads the exact bytes npm pack produces, so the SHA computed
# here will match what ends up on the npm registry.
FORMULA="$REPO_ROOT/Formula/dokkimi.rb"
if [ -f "$FORMULA" ]; then
  echo ""
  echo "==> Packing staging tarball and updating Formula/dokkimi.rb"
  TARBALL=$(npm pack --json 2>/dev/null | node -e "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d)[0].filename))")
  SHA=$(shasum -a 256 "$TARBALL" | awk '{print $1}')
  rm -f "$TARBALL"

  node -e "
    const fs = require('fs');
    const path = '$FORMULA';
    const ver = '$BUILT_VERSION';
    const sha = '$SHA';
    let src = fs.readFileSync(path, 'utf8');
    src = src.replace(/url \"https:\/\/registry\.npmjs\.org\/dokkimi\/-\/dokkimi-[^\"]+\.tgz\"/, 'url \"https://registry.npmjs.org/dokkimi/-/dokkimi-' + ver + '.tgz\"');
    src = src.replace(/sha256 \"[a-f0-9]{64}\"/, 'sha256 \"' + sha + '\"');
    fs.writeFileSync(path, src);
  "
  echo "  URL:    https://registry.npmjs.org/dokkimi/-/dokkimi-${BUILT_VERSION}.tgz"
  echo "  SHA256: ${SHA}"
fi

echo ""
echo "=========================================="
echo "  Build complete: dokkimi v${BUILT_VERSION}"
echo "=========================================="
echo ""
echo "  Test locally:"
echo "    npm install -g $STAGE_DIR"
echo "    dokkimi version"
echo "    dokkimi doctor"
echo ""
echo "  Commit all changes (VERSION + package.json files + Formula/dokkimi.rb)"
echo "  before publishing."
echo ""
echo "  When ready to publish:"
echo "    ./scripts/publish-package.sh"
echo ""
