#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=$(cat "$REPO_ROOT/VERSION" | tr -d '[:space:]')
TAG="v${VERSION}"

echo ""
echo "  This will delete and re-push tag ${TAG} on the current commit."
echo "  This triggers the GitHub Actions workflow to rebuild Go images."
echo ""
echo "  Current commit: $(git log -1 --oneline)"
echo ""

read -p "  Continue? (y/n): " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "yes" ]; then
  echo "  Aborted."
  exit 0
fi

echo ""
echo "==> Deleting local tag ${TAG}"
git tag -d "$TAG" 2>/dev/null || true

echo "==> Deleting remote tag ${TAG}"
git push origin ":refs/tags/${TAG}" 2>/dev/null || true

echo "==> Creating tag ${TAG} on HEAD"
git tag "$TAG"

echo "==> Pushing tag ${TAG}"
git push origin "$TAG"

echo ""
echo "  Done. Tag ${TAG} now points to $(git rev-parse --short HEAD)."
echo "  Check workflow: https://github.com/dokkimi/dokkimi/actions"
echo ""
