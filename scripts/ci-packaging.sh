#!/usr/bin/env bash
# ============================================================================
# Packaging + distribution checks
# ============================================================================
# The part of CI BEYOND typecheck / docs / test: build the dist, lint the
# package surface, verify the published types, and smoke-test the actual
# installed artifact. Mirrors the build + publint + attw + pack + install-smoke
# + onboarding-smoke steps of .github/workflows/ci.yml.
#
# Shared by scripts/ci-local.sh and the pre-push hook so local and cloud can't
# drift. Each step prints a header; first failure exits non-zero.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

hdr() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
die() { printf '\n\033[31m✗ packaging failed at: %s\033[0m\n' "$1"; exit 1; }

hdr "build";            npm run build                          || die "build"
hdr "publint";          npx --yes publint                      || die "publint"
hdr "attw (published types)"
npx --yes --package=@arethetypeswrong/cli attw --pack . --profile esm-only || die "attw"
hdr "pack --dry-run";   npm pack --dry-run >/dev/null          || die "pack --dry-run"
hdr "tarball install smoke"
bash scripts/smoke-tarball-install.sh                          || die "tarball install smoke"
hdr "onboarding smoke (git-clone install path)"
INTERLINKED_REPO_URL="$REPO_ROOT" INTERLINKED_REPO_REF=HEAD \
  bash scripts/smoke-onboarding.sh                             || die "onboarding smoke"
