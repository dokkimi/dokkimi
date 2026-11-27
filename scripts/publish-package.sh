#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE_DIR="$REPO_ROOT/.publish-staging"
FORMULA="$REPO_ROOT/Formula/dokkimi.rb"

if [ ! -f "$STAGE_DIR/package.json" ]; then
  echo ""
  echo "  No build found. Run ./scripts/build-package.sh first."
  echo ""
  exit 1
fi

VERSION=$(node -e "console.log(require('$STAGE_DIR/package.json').version)")
REPO_VERSION=$(cat "$REPO_ROOT/VERSION" | tr -d '[:space:]')

if [ "$VERSION" != "$REPO_VERSION" ]; then
  echo ""
  echo "  Warning: staged package is v${VERSION} but VERSION file says ${REPO_VERSION}."
  echo "  You may want to rebuild with ./scripts/build-package.sh"
  echo ""
  read -p "  Continue anyway? (y/n): " confirm
  if [ "$confirm" != "y" ] && [ "$confirm" != "yes" ]; then
    echo "  Aborted."
    exit 0
  fi
fi

# Verify the staged build is this commit's. build-package.sh records the commit
# it built; only the files the build itself changes (version files, formula)
# may differ, and they must be committed.
BUILD_CHANGED_FILES='^(VERSION|(.*/)?package\.json|shared/config/version\.ts|Formula/dokkimi\.rb)$'
BUILT_FROM_FILE="$STAGE_DIR/.built-from"
if [ ! -f "$BUILT_FROM_FILE" ]; then
  echo ""
  echo "  Error: the staged build doesn't record its commit. Rebuild with ./scripts/build-package.sh"
  echo ""
  exit 1
fi
BUILT_FROM=$(head -1 "$BUILT_FROM_FILE")
if grep -q '^dirty$' "$BUILT_FROM_FILE"; then
  echo ""
  echo "  Error: the staged build was made with uncommitted changes, so it matches no commit."
  echo "  Commit them, then rebuild with ./scripts/build-package.sh"
  echo ""
  exit 1
fi
if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
  echo ""
  echo "  Error: the working tree has uncommitted changes. Commit them first."
  echo ""
  exit 1
fi
if ! git -C "$REPO_ROOT" cat-file -e "${BUILT_FROM}^{commit}" 2>/dev/null; then
  echo ""
  echo "  Error: the staged build is from commit ${BUILT_FROM}, which isn't in this repo. Rebuild."
  echo ""
  exit 1
fi
CHANGED_SINCE_BUILD=$(git -C "$REPO_ROOT" diff --name-only "$BUILT_FROM" HEAD | grep -vE "$BUILD_CHANGED_FILES" || true)
if [ -n "$CHANGED_SINCE_BUILD" ]; then
  echo ""
  echo "  Error: files changed since the staged build (from ${BUILT_FROM:0:7}):"
  echo "$CHANGED_SINCE_BUILD" | sed 's/^/    /'
  echo "  Rebuild with ./scripts/build-package.sh"
  echo ""
  exit 1
fi
PUBLISHED_COMMIT=$(git -C "$REPO_ROOT" rev-parse HEAD)

# Verify the formula in the repo matches the version we're about to publish.
# If it doesn't, build-package.sh either wasn't re-run after a version change,
# or the formula update got lost — abort rather than publish something whose
# brew bump will fail.
if [ -f "$FORMULA" ]; then
  if ! grep -q "dokkimi-${VERSION}\.tgz" "$FORMULA"; then
    echo ""
    echo "  Error: Formula/dokkimi.rb does not reference v${VERSION}."
    echo "  Re-run ./scripts/build-package.sh to update the formula, then commit."
    echo ""
    exit 1
  fi
fi

echo ""
echo "  About to publish dokkimi v${VERSION} to npm."
echo ""

# Check npm auth
if ! npm whoami &>/dev/null; then
  echo "  You're not logged in to npm. Running npm login..."
  echo ""
  npm login
fi

NPM_USER=$(npm whoami)
echo "  Logged in as: $NPM_USER"
echo ""

# Check if this version already exists
if npm view "dokkimi@${VERSION}" version &>/dev/null 2>&1; then
  echo "  Error: dokkimi@${VERSION} already exists on npm."
  echo "  Bump the version and rebuild first."
  echo ""
  exit 1
fi

read -p "  Publish dokkimi v${VERSION}? (y/n): " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "yes" ]; then
  echo "  Aborted."
  exit 0
fi

echo ""
echo "==> Publishing..."
cd "$STAGE_DIR"
npm publish

cd "$REPO_ROOT"

# Tag brew-v${VERSION} so the sync workflow mirrors Formula/dokkimi.rb to the tap.
# Guard: only auto-tag if on main with a clean tree — otherwise we might tag
# the wrong commit.
BRANCH=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)
DIRTY=$(git -C "$REPO_ROOT" status --porcelain)

if [ "$BRANCH" != "main" ]; then
  echo ""
  echo "  Not on 'main' (current: $BRANCH). Skipping brew-v${VERSION} tag."
  echo "  Once your changes are on main, tag manually:"
  echo "    git tag brew-v${VERSION} && git push origin brew-v${VERSION}"
elif [ -n "$DIRTY" ]; then
  echo ""
  echo "  Working tree has uncommitted changes. Skipping brew-v${VERSION} tag."
  echo "  Commit + push, then tag manually:"
  echo "    git tag brew-v${VERSION} && git push origin brew-v${VERSION}"
else
  echo ""
  echo "==> Tagging brew-v${VERSION}"
  git -C "$REPO_ROOT" tag "brew-v${VERSION}"
  git -C "$REPO_ROOT" push origin "brew-v${VERSION}"
  echo "  Tag pushed — Homebrew tap sync workflow will fire shortly."
  echo "  Watch: https://github.com/dokkimi/dokkimi/actions/workflows/update-homebrew.yml"
fi

echo ""
echo "==> Creating GitHub Release"
echo ""
read -p "  Create a GitHub Release for v${VERSION}? (y/n): " create_release
if [ "$create_release" = "y" ] || [ "$create_release" = "yes" ]; then
  RELEASE_NOTES_FILE=$(mktemp)
  echo "## What's Changed" > "$RELEASE_NOTES_FILE"
  echo "" >> "$RELEASE_NOTES_FILE"
  echo "- " >> "$RELEASE_NOTES_FILE"
  ${EDITOR:-vi} "$RELEASE_NOTES_FILE"
  # Tag the commit that was published, not whatever main is now
  gh release create "v${VERSION}" --target "$PUBLISHED_COMMIT" --title "v${VERSION}" --notes-file "$RELEASE_NOTES_FILE"
  rm -f "$RELEASE_NOTES_FILE"
  echo "  GitHub Release created."
else
  echo "  Skipped. Create one later with: gh release create v${VERSION} --target ${PUBLISHED_COMMIT}"
fi

echo ""
echo "=========================================="
echo "  Published dokkimi v${VERSION}"
echo "=========================================="
echo ""
echo "  Users can install with:"
echo "    npm install -g dokkimi"
echo "    brew install dokkimi/tap/dokkimi"
echo ""
