#!/usr/bin/env bash
# ============================================================================
# Tarball install smoke
# ============================================================================
# Pack the package, install it into a throwaway project, and exercise the
# published bins (interlinked + interlinked-hook). Catches broken exports / bin
# paths / missing dist files BEFORE they ship — the class of failure unit tests
# can't see because they run against src/, not the packed artifact.
#
# Single source of truth: invoked by .github/workflows/ci.yml, scripts/
# ci-packaging.sh (→ ci:local), and the pre-push hook, so the published-package
# check can't drift between cloud and local.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PACK_DIR="$(mktemp -d)"
SMOKE_DIR="$(mktemp -d)"
cleanup() { rm -rf "$PACK_DIR" "$SMOKE_DIR"; }
trap cleanup EXIT

# `npm pack` runs prepack → build, so the tarball reflects current source.
npm pack --pack-destination "$PACK_DIR" >/dev/null
TARBALL="$(ls -t "$PACK_DIR"/interlinked-cli-*.tgz | head -n 1)"
echo "Installing: $TARBALL"

cd "$SMOKE_DIR"
npm init -y >/dev/null
npm install --no-save "$TARBALL" >/dev/null

INTERLINKED=./node_modules/.bin/interlinked
HOOK=./node_modules/.bin/interlinked-hook

"$INTERLINKED" --version
"$INTERLINKED" --help | head -5
"$INTERLINKED" install-hooks --runner claude-code --mode balanced --json >/dev/null
test -f .claude/settings.json
grep -q -- "--runner 'claude-code'" .claude/settings.json
printf '{"session_id":"smoke","cwd":"%s","tool_name":"Read","tool_input":{"file_path":"README.md"}}' "$PWD" \
  | "$HOOK" --runner claude-code --event PreToolUse >/dev/null
mkdir -p src
"$INTERLINKED" write src/smoke.ts --stdin --json <<< 'export const smoke: number = 1;' >/dev/null

echo "✓ tarball install smoke passed"
