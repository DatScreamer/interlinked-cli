#!/usr/bin/env bash
# ============================================================================
# Local CI — run the whole CI job on THIS machine, zero GitHub Actions minutes
# ============================================================================
# Reproduces what the cloud ubuntu leg runs (see .github/workflows/ci.yml),
# minus the Linux platform itself (use `act` if you need that). Order is
# fast-fail: cheap deterministic checks, then packaging/distribution, then the
# full test suite (the long pole) last — so a typo fails in seconds, not after
# four minutes of tests.
#
#   npm run ci:local
#
# This is the same set the pre-push hook runs (typecheck/docs/test always;
# packaging only when the package surface changed), so a green ci:local means a
# green push and a green cloud run.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

hdr() { printf '\n\033[1m\033[36m══ %s ══\033[0m\n' "$1"; }

hdr "typecheck:stable (tsc)"; npm run typecheck:stable || { echo "✗ typecheck:stable"; exit 1; }
hdr "docs:check";            npm run docs:check         || { echo "✗ docs:check"; exit 1; }
hdr "packaging + smokes";    bash scripts/ci-packaging.sh || { echo "✗ packaging"; exit 1; }
hdr "test (CI=1, full suite — the long pole)"; CI=1 npm test || { echo "✗ test"; exit 1; }

printf '\n\033[1m\033[32m✓ ci:local passed — parity with the cloud ubuntu job (on this platform)\033[0m\n'
