#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$SCRIPT_DIR/../apps/vscode"

cd "$EXT_DIR"

echo "Building and packaging extension..."
yarn package

VSIX=$(ls -t dokkimi-vscode-*.vsix | head -1)
if [ -z "$VSIX" ]; then
  echo "Error: no .vsix file found after packaging"
  exit 1
fi

echo "Installing $VSIX..."
code --install-extension "$VSIX" --force

echo "Reloading VS Code window..."
code --command workbench.action.reloadWindow 2>/dev/null || true

echo "Done. If the window didn't reload, run 'Developer: Reload Window' from the command palette."
