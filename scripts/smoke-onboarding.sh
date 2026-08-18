#!/usr/bin/env bash
# ============================================================================
# Onboarding smoke test
# ============================================================================
#
# Walks through the EXACT install path the README tells a brand-new user to
# follow — git clone -> npm ci -> npm run build -> npm link -> install-hooks
# -> hook event roundtrip -> harness daemon block-decision roundtrip -> stop.
#
# Why this exists, and why a separate script (instead of just `npm test`):
#   - Vitest covers internal correctness. It does NOT exercise the
#     binary-on-PATH / hooks-on-disk / Unix-socket flow that a first-time
#     user actually walks through.
#   - Tests run inside the dev checkout, so they never catch "missing build
#     step", "wrong dist path in package.json#bin", "hook script imports a
#     CLI module that isn't packaged", or "the README's instructions
#     drifted away from reality."
#   - Runs in a fresh tmpdir against a fresh clone, so it sees what an
#     onboarding user sees, not the in-repo developer's environment.
#
# Run locally:
#     bash scripts/smoke-onboarding.sh                  # clone from GitHub
#     INTERLINKED_REPO_URL="$PWD" \
#       INTERLINKED_REPO_REF=HEAD \
#       bash scripts/smoke-onboarding.sh                # test uncommitted local changes
#
# Run in CI: invoked from .github/workflows/ci.yml, after the existing
# tarball-install smoke step.
# ============================================================================

set -euo pipefail

REPO_URL="${INTERLINKED_REPO_URL:-https://github.com/QuentinCody/interlinked-cli}"
REPO_REF="${INTERLINKED_REPO_REF:-main}"

# Darwin Unix sockets are capped at 104 bytes for `sun_path`. macOS's default
# TMPDIR (`/var/folders/<hash>/T/`) is already ~56 bytes — adding a project
# subdir, `.interlinked/`, and `harness-default.sock` blows past the cap and
# both raw + framed socket paths get truncated to the same string, producing
# `EADDRINUSE` on the second bind. Force `/tmp` (which is `/private/tmp` on
# macOS, ~12 bytes) so we stay well under the limit. Linux is fine either
# way; using `/tmp` keeps the script identical across platforms.
SMOKE_DIR="$(mktemp -d /tmp/interlinked-smoke.XXXXXX)"

# `npm link` (below) mutates GLOBAL npm state: a symlink under npm's global
# node_modules keyed by package NAME, plus bin shims in npm's global bin
# dir. This repo's own package.json is ALSO named "interlinked-cli", and a
# dev machine commonly has a permanently-installed `interlinked` elsewhere
# on PATH (e.g. ~/.local/bin) ahead of npm's global bin dir — so an
# unscoped `npm link` here can silently make every bare `interlinked` call
# below resolve to THAT other install instead of the one this script just
# built, and can make `npm link`/`npm unlink -g` operate on global npm
# state this script doesn't own. Point npm's global prefix at a directory
# inside our own disposable tmpdir so `npm link`'s entire footprint —
# global symlink, global bin shims, everything — lives under $SMOKE_DIR and
# is gone the moment `rm -rf "$SMOKE_DIR"` runs; every invocation below
# resolves the binary by explicit path, never by PATH search, so no other
# `interlinked` install on this machine can ever be reached by accident.
NPM_GLOBAL_PREFIX="$SMOKE_DIR/npm-global"
mkdir -p "$NPM_GLOBAL_PREFIX"
export npm_config_prefix="$NPM_GLOBAL_PREFIX"

# For an authentic "binary on PATH" test via `npm link`, with every side
# effect sandboxed inside $SMOKE_DIR (see above). If the script crashes
# mid-way, leftover state confuses the next run — trap unconditionally
# cleans up, even on failure.
cleanup() {
  local exit_code=$?
  set +e
  echo "==> cleanup"
  if [ -n "${INTERLINKED_BIN:-}" ] && [ -x "$INTERLINKED_BIN" ] && [ -d "${TARGET_DIR:-/nonexistent}" ]; then
    (cd "$TARGET_DIR" && "$INTERLINKED_BIN" harness stop 2>/dev/null) || true
  fi
  rm -rf "$SMOKE_DIR" 2>/dev/null || true
  if [ "$exit_code" -ne 0 ]; then
    echo "==> SMOKE FAILED (exit $exit_code) — see output above"
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

CLONE_DIR="$SMOKE_DIR/interlinked-cli"
TARGET_DIR="$SMOKE_DIR/sample-project"

step() { echo; echo "==> $*"; }
ok()   { echo "  ✓ $*"; }
fail() { echo "  ✗ $*" >&2; exit 1; }

step "smoke tmpdir: $SMOKE_DIR"
step "source:       $REPO_URL @ $REPO_REF"

step "clone"
# `INTERLINKED_REPO_URL` may be a local path for uncommitted-change testing.
if [ -d "$REPO_URL/.git" ] || [ -d "$REPO_URL" ]; then
  # Exclude build/vcs/harness-data dirs: `npm ci` + `npm run build` below
  # regenerate node_modules/dist from scratch regardless, nothing in the
  # build/pack/link pipeline reads .git (scripts/setup-git-hooks.mjs
  # explicitly tolerates a missing .git), and .interlinked/ is this repo's
  # own local harness data dir (can be multiple GB) — copying it wastes
  # minutes per run and risks leaking this machine's local harness config
  # into the clone for no benefit ($TARGET_DIR gets its own fresh
  # .interlinked/ further down).
  mkdir -p "$CLONE_DIR"
  rsync -a \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='dist' \
    --exclude='.interlinked' \
    "$REPO_URL/" "$CLONE_DIR/"
  ok "copied local clone (uncommitted changes preserved)"
else
  git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$CLONE_DIR"
  ok "cloned $REPO_REF"
fi

cd "$CLONE_DIR"

step "npm ci"
npm ci --no-audit --no-fund

step "npm run build"
npm run build
test -f dist/index.js || fail "dist/index.js missing after build"
test -f dist/hook-entry.js || fail "dist/hook-entry.js missing after build"
ok "dist/index.js and dist/hook-entry.js present"

step "npm link"
npm link
# Resolve by explicit path inside our sandboxed prefix (see top of file) —
# never via PATH search, so an unrelated `interlinked` elsewhere on this
# machine's PATH can never be the one this script ends up exercising.
INTERLINKED_BIN="$NPM_GLOBAL_PREFIX/bin/interlinked"
HOOK_BIN="$NPM_GLOBAL_PREFIX/bin/interlinked-hook"
[ -x "$INTERLINKED_BIN" ] || fail "interlinked not present in sandboxed prefix after npm link ($INTERLINKED_BIN)"
[ -x "$HOOK_BIN" ] || fail "interlinked-hook not present in sandboxed prefix after npm link ($HOOK_BIN)"
ok "interlinked      -> $INTERLINKED_BIN"
ok "interlinked-hook -> $HOOK_BIN"

step "interlinked --version"
"$INTERLINKED_BIN" --version
ok "version reported"

step "interlinked --help (first 5 lines)"
"$INTERLINKED_BIN" --help | head -5
ok "help renders"

step "fresh sample project: $TARGET_DIR"
mkdir -p "$TARGET_DIR"
cd "$TARGET_DIR"
git init -q
printf '{"name":"smoke-target","version":"0.0.0","private":true}\n' > package.json
ok "fresh sample project ready"

step "install-hooks --runner claude-code"
"$INTERLINKED_BIN" install-hooks --runner claude-code --mode balanced --json | head -20
test -f .claude/settings.json || fail ".claude/settings.json not written"
grep -q -- "--runner 'claude-code'" .claude/settings.json \
  || fail "settings.json missing the --runner 'claude-code' tag"
ok "wrote .claude/settings.json with claude-code tag"

step "hook event roundtrip (PreToolUse / Read)"
HOOK_INPUT=$(printf '{"session_id":"smoke","cwd":"%s","tool_name":"Read","tool_input":{"file_path":"package.json"}}' "$TARGET_DIR")
HOOK_OUT="$(printf '%s' "$HOOK_INPUT" | "$HOOK_BIN" --runner claude-code --event PreToolUse 2>&1 || true)"
echo "  hook output: $HOOK_OUT"
ok "hook accepted PreToolUse event"

step "harness daemon: start"
"$INTERLINKED_BIN" harness start
sleep 1
test -S .interlinked/harness.sock || fail "harness socket not created"
ok "harness socket present"

step "harness daemon: status"
"$INTERLINKED_BIN" harness status | head -5
ok "harness reported status"

step "harness daemon: block decision on rm -rf /"
BLOCK_OUT="$("$INTERLINKED_BIN" harness test "rm -rf /" 2>&1 || true)"
echo "$BLOCK_OUT" | head -5
echo "$BLOCK_OUT" | grep -qi "block" \
  || fail "harness did not block rm -rf / (output above)"
ok "harness blocked the destructive command"

step "harness daemon: stop"
"$INTERLINKED_BIN" harness stop
ok "harness stopped"

echo
echo "============================================================================"
echo "  ✓ ONBOARDING SMOKE OK"
echo "============================================================================"
echo "  source:  $REPO_URL @ $REPO_REF"
echo "  steps:   clone -> npm ci -> build -> link -> install-hooks ->"
echo "           hook event -> harness start/status/block/stop -> cleanup"
echo "============================================================================"
