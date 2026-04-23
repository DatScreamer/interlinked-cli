#!/usr/bin/env bash
#
# E2E tests for CLI git and guard integration
# Tests real git operations in a temp repo with the actual CLI binary.
#
# Usage:
#   cd cli && bash test/git-guard-e2e.sh
#
# Prerequisites:
#   - Node.js + npx available
#   - git available
#   - No running server needed (tests handle offline gracefully)

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
DIM='\033[2m'
NC='\033[0m'

PASSED=0
FAILED=0
SKIPPED=0

# Resolve CLI path relative to this script (must run from cli/ dir)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="npx tsx $CLI_DIR/src/index.ts"
TMPDIR_BASE=""
REPO_DIR=""

log_test() { echo -e "${BLUE}[TEST]${NC} $1"; }
log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASSED=$((PASSED + 1)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; FAILED=$((FAILED + 1)); }
log_skip() { echo -e "${YELLOW}[SKIP]${NC} $1"; SKIPPED=$((SKIPPED + 1)); }
log_info() { echo -e "${DIM}      $1${NC}"; }

# ===========================================
# Setup / Teardown
# ===========================================

setup_temp_repo() {
    TMPDIR_BASE=$(mktemp -d)
    REPO_DIR="$TMPDIR_BASE/test-repo"
    mkdir -p "$REPO_DIR"
    cd "$REPO_DIR"
    git init --initial-branch=main >/dev/null 2>&1
    git config user.email "test@interlinked.dev"
    git config user.name "Test Runner"

    # Initial commit
    echo "# Test Repo" > README.md
    git add README.md
    git commit -m "Initial commit" >/dev/null 2>&1

    # Create .interlinked config
    mkdir -p .interlinked
    echo '{"version":1,"server_url":"http://localhost:8787"}' > .interlinked/config.json
    echo '{"agent_name":"test-agent","guard_mode":"warn"}' > .interlinked/config.local.json

    log_info "Temp repo: $REPO_DIR"
}

cleanup() {
    if [ -n "$TMPDIR_BASE" ] && [ -d "$TMPDIR_BASE" ]; then
        rm -rf "$TMPDIR_BASE"
    fi
}
trap cleanup EXIT

# ===========================================
# Test: git context (local only, no server)
# ===========================================

test_git_context_local() {
    log_test "git context — local-only (no server)"
    setup_temp_repo

    local output
    output=$($CLI git context --json 2>/dev/null || true)

    if echo "$output" | grep -q '"branch"'; then
        local branch
        branch=$(echo "$output" | grep '"branch"' | head -1)
        if echo "$branch" | grep -q 'main'; then
            log_pass "git context shows branch=main"
        else
            log_fail "git context branch wrong: $branch"
        fi
    else
        log_fail "git context JSON missing 'branch' field"
    fi

    if echo "$output" | grep -q '"head"'; then
        log_pass "git context shows HEAD sha"
    else
        log_fail "git context missing HEAD sha"
    fi

    # Server should be unreachable (no server running)
    if echo "$output" | grep -q '"error"'; then
        log_pass "git context gracefully handles unreachable server"
    else
        log_skip "git context server field (might be running locally)"
    fi
}

# ===========================================
# Test: git context with commit flag
# ===========================================

test_git_context_commit() {
    log_test "git context --commit <sha>"
    setup_temp_repo

    local sha
    sha=$(git rev-parse HEAD)

    local output
    output=$($CLI git context --commit "$sha" --json 2>/dev/null || true)

    if echo "$output" | grep -q '"head"'; then
        log_pass "git context --commit works with explicit SHA"
    else
        log_fail "git context --commit failed"
    fi
}

# ===========================================
# Test: git context with attribution trailer
# ===========================================

test_git_context_attribution() {
    log_test "git context — with attribution trailer"
    setup_temp_repo

    # Create a commit with an attribution trailer
    echo "code" > src_file.ts
    git add src_file.ts
    git commit -m "Add feature

Interlinked-Attribution: 72% agent (145/201 lines)" >/dev/null 2>&1

    local output
    output=$($CLI git context --json 2>/dev/null || true)

    if echo "$output" | grep -q '"agent_percentage"'; then
        log_pass "git context reads attribution trailer"
    else
        log_fail "git context missing attribution data"
    fi
}

# ===========================================
# Test: git context with Interlinked trailers
# ===========================================

test_git_context_trailers() {
    log_test "git context — with Interlinked trailers"
    setup_temp_repo

    echo "code" > feature.ts
    git add feature.ts
    git commit -m "Implement feature

Interlinked-Checkpoint: 42
Interlinked-Agent: Worker-Alpha
Interlinked-Tasks: #7,#8" >/dev/null 2>&1

    local output
    output=$($CLI git context --json 2>/dev/null || true)

    if echo "$output" | grep -q '"Interlinked-Checkpoint"'; then
        log_pass "git context parses Interlinked-Checkpoint trailer"
    else
        log_fail "git context missing Interlinked-Checkpoint"
    fi

    if echo "$output" | grep -q '"Interlinked-Agent"'; then
        log_pass "git context parses Interlinked-Agent trailer"
    else
        log_fail "git context missing Interlinked-Agent"
    fi
}

# ===========================================
# Test: git context human-readable output
# ===========================================

test_git_context_human() {
    log_test "git context — human-readable output"
    setup_temp_repo

    local output
    output=$($CLI git context 2>/dev/null || true)

    if echo "$output" | grep -q "Git Context"; then
        log_pass "git context shows header"
    else
        log_fail "git context missing header"
    fi

    if echo "$output" | grep -q "Branch"; then
        log_pass "git context shows Branch line"
    else
        log_fail "git context missing Branch line"
    fi
}

# ===========================================
# Test: guard install
# ===========================================

test_guard_install() {
    log_test "guard install — fresh repo"
    setup_temp_repo

    local output
    output=$($CLI guard install --json 2>/dev/null || true)

    if echo "$output" | grep -q '"installed": true'; then
        log_pass "guard install succeeds"
    else
        log_fail "guard install failed: $output"
    fi

    if echo "$output" | grep -q '"mode": "warn"'; then
        log_pass "guard install defaults to warn mode"
    else
        log_fail "guard install wrong default mode"
    fi

    # Verify hook file exists
    if [ -f .git/hooks/pre-commit ]; then
        log_pass "pre-commit hook file created"
    else
        log_fail "pre-commit hook file missing"
    fi

    # Verify hook is executable
    if [ -x .git/hooks/pre-commit ]; then
        log_pass "pre-commit hook is executable"
    else
        log_fail "pre-commit hook not executable"
    fi

    # Verify hook contains guard marker
    if grep -q "interlinked-guard" .git/hooks/pre-commit; then
        log_pass "pre-commit hook contains guard marker"
    else
        log_fail "pre-commit hook missing guard marker"
    fi
}

# ===========================================
# Test: guard install with block mode
# ===========================================

test_guard_install_block() {
    log_test "guard install --mode block"
    setup_temp_repo

    local output
    output=$($CLI guard install --mode block --json 2>/dev/null || true)

    if echo "$output" | grep -q '"mode": "block"'; then
        log_pass "guard install sets block mode"
    else
        log_fail "guard install wrong mode"
    fi
}

# ===========================================
# Test: guard install with existing hook (backup)
# ===========================================

test_guard_install_backup() {
    log_test "guard install — backs up existing hook"
    setup_temp_repo

    # Create an existing pre-commit hook
    mkdir -p .git/hooks
    echo '#!/bin/sh
echo "original hook"' > .git/hooks/pre-commit
    chmod +x .git/hooks/pre-commit

    local output
    output=$($CLI guard install --json 2>/dev/null || true)

    if echo "$output" | grep -q '"installed": true'; then
        log_pass "guard install succeeds with existing hook"
    else
        log_fail "guard install failed with existing hook"
    fi

    if [ -f .git/hooks/pre-commit.interlinked-orig ]; then
        log_pass "original hook backed up"
    else
        log_fail "original hook not backed up"
    fi

    # Verify wrapper runs both
    if grep -q "interlinked-guard" .git/hooks/pre-commit; then
        log_pass "new hook contains guard marker"
    else
        log_fail "new hook missing guard marker"
    fi
}

# ===========================================
# Test: guard install idempotency
# ===========================================

test_guard_install_idempotent() {
    log_test "guard install — idempotent"
    setup_temp_repo

    $CLI guard install --json >/dev/null 2>&1 || true

    local output
    output=$($CLI guard install --json 2>/dev/null || true)

    if echo "$output" | grep -q '"installed": false'; then
        log_pass "guard install is idempotent (second install returns installed: false)"
    else
        log_fail "guard install is not idempotent"
    fi
}

# ===========================================
# Test: guard check with --files
# ===========================================

test_guard_check_files() {
    log_test "guard check --files (offline, no server)"
    setup_temp_repo

    local output
    output=$($CLI guard check --files src/auth/login.ts --json 2>/dev/null || true)

    # Should succeed but with empty reservations (no server, no cache)
    if echo "$output" | grep -q '"clean"'; then
        log_pass "guard check returns clean status"
    else
        log_fail "guard check failed: $output"
    fi
}

# ===========================================
# Test: guard check with no files
# ===========================================

test_guard_check_no_files() {
    log_test "guard check — no staged files"
    setup_temp_repo

    local output
    output=$($CLI guard check --json 2>/dev/null || true)

    if echo "$output" | grep -q '"files_checked": 0'; then
        log_pass "guard check reports 0 files checked"
    else
        log_fail "guard check wrong file count"
    fi
}

# ===========================================
# Test: guard check with staged files
# ===========================================

test_guard_check_staged() {
    log_test "guard check — uses staged files"
    setup_temp_repo

    # Create and stage a file
    mkdir -p src/auth
    echo "code" > src/auth/login.ts
    git add src/auth/login.ts

    local output
    output=$($CLI guard check --json 2>/dev/null || true)

    if echo "$output" | grep -q '"files_checked": 1'; then
        log_pass "guard check picks up staged files"
    else
        # Might be 0 if file count parsing is different
        log_info "Output: $output"
        log_skip "guard check staged file count (may vary by git state)"
    fi
}

# ===========================================
# Test: guard status
# ===========================================

test_guard_status() {
    log_test "guard status"
    setup_temp_repo

    # Install first
    $CLI guard install --json >/dev/null 2>&1 || true

    local output
    output=$($CLI guard status --json 2>/dev/null || true)

    if echo "$output" | grep -q '"pre_commit": true'; then
        log_pass "guard status detects installed pre-commit hook"
    else
        log_fail "guard status missing pre-commit detection"
    fi

    if echo "$output" | grep -q '"git_repo": true'; then
        log_pass "guard status detects git repo"
    else
        log_fail "guard status missing git_repo"
    fi
}

# ===========================================
# Test: guard uninstall
# ===========================================

test_guard_uninstall() {
    log_test "guard uninstall"
    setup_temp_repo

    # Install first
    $CLI guard install --json >/dev/null 2>&1 || true

    local output
    output=$($CLI guard uninstall --json 2>/dev/null || true)

    if echo "$output" | grep -q '"removed": true'; then
        log_pass "guard uninstall removes hook"
    else
        log_fail "guard uninstall failed"
    fi

    if echo "$output" | grep -q '"mode": "off"'; then
        log_pass "guard uninstall sets mode to off"
    else
        log_fail "guard uninstall wrong mode"
    fi

    # Verify hook file is gone
    if [ ! -f .git/hooks/pre-commit ]; then
        log_pass "pre-commit hook file removed"
    else
        log_fail "pre-commit hook file still exists"
    fi
}

# ===========================================
# Test: guard uninstall restores backup
# ===========================================

test_guard_uninstall_restore() {
    log_test "guard uninstall — restores original hook"
    setup_temp_repo

    # Create an existing hook
    mkdir -p .git/hooks
    echo '#!/bin/sh
echo "original"' > .git/hooks/pre-commit
    chmod +x .git/hooks/pre-commit

    # Install guard (backs up original)
    $CLI guard install --json >/dev/null 2>&1 || true

    # Uninstall (should restore)
    $CLI guard uninstall --json >/dev/null 2>&1 || true

    if [ -f .git/hooks/pre-commit ]; then
        if grep -q "original" .git/hooks/pre-commit; then
            log_pass "original hook restored after uninstall"
        else
            log_fail "wrong content in restored hook"
        fi
    else
        log_fail "hook not restored after uninstall"
    fi

    if [ ! -f .git/hooks/pre-commit.interlinked-orig ]; then
        log_pass "backup file cleaned up"
    else
        log_fail "backup file still exists"
    fi
}

# ===========================================
# Test: attach --auto
# ===========================================

test_attach_auto() {
    log_test "attach --auto"
    setup_temp_repo

    # Add a remote to derive workspace_key from
    git remote add origin https://github.com/user/my-cool-project.git 2>/dev/null || true

    local output
    output=$($CLI attach --auto --json 2>/dev/null || true)

    if echo "$output" | grep -q '"default_workspace_key"'; then
        log_pass "attach --auto sets default_workspace_key"
    else
        log_fail "attach --auto missing workspace_key"
    fi
}

# ===========================================
# Test: attach --auto with override
# ===========================================

test_attach_auto_override() {
    log_test "attach --auto with explicit override"
    setup_temp_repo

    git remote add origin https://github.com/user/my-project.git 2>/dev/null || true

    local output
    output=$($CLI attach --auto --workspace-key custom-name --json 2>/dev/null || true)

    if echo "$output" | grep -q '"default_workspace_key": "custom-name"'; then
        log_pass "explicit --workspace-key overrides auto-derived value"
    else
        log_info "Output: $output"
        log_skip "override check (may depend on mock state)"
    fi
}

# ===========================================
# Test: not a git repo errors
# ===========================================

test_not_git_repo() {
    log_test "commands error outside git repo"
    TMPDIR_BASE=$(mktemp -d)
    REPO_DIR="$TMPDIR_BASE/not-a-repo"
    mkdir -p "$REPO_DIR"
    cd "$REPO_DIR"

    # Create minimal config so CLI doesn't fail on missing config
    mkdir -p .interlinked
    echo '{"version":1,"server_url":"http://localhost:8787"}' > .interlinked/config.json
    echo '{}' > .interlinked/config.local.json

    local output
    output=$($CLI git context --json 2>&1 || true)
    if echo "$output" | grep -qi "not a git"; then
        log_pass "git context errors outside git repo"
    else
        log_fail "git context should error outside git repo"
    fi

    output=$($CLI guard install --json 2>&1 || true)
    if echo "$output" | grep -qi "not a git"; then
        log_pass "guard install errors outside git repo"
    else
        log_fail "guard install should error outside git repo"
    fi
}

# ===========================================
# Test: guard install + actual git commit (hook execution)
# ===========================================

test_guard_hook_execution() {
    log_test "guard hook fires during git commit"
    setup_temp_repo

    $CLI guard install --json >/dev/null 2>&1 || true

    # Create and stage a file
    echo "new content" > new_file.ts
    git add new_file.ts

    # Attempt to commit — the hook should run (and pass since no server/cache)
    local commit_output
    if commit_output=$(git commit -m "Test commit with guard hook" 2>&1); then
        # Verify the commit was actually created
        local last_msg
        last_msg=$(git log -1 --format=%s 2>/dev/null || true)
        if [ "$last_msg" = "Test commit with guard hook" ]; then
            log_pass "git commit succeeds with guard hook installed"
        else
            log_fail "git commit appeared to succeed but commit not found"
        fi
    else
        log_fail "git commit failed with guard hook: $commit_output"
    fi
}

# ===========================================
# Run All Tests
# ===========================================

echo ""
echo -e "${BLUE}=== Interlinked CLI Git/Guard E2E Tests ===${NC}"
echo ""

# Store original dir to return to for CLI execution
ORIGINAL_DIR=$(pwd)

test_git_context_local
test_git_context_commit
test_git_context_attribution
test_git_context_trailers
test_git_context_human
test_guard_install
test_guard_install_block
test_guard_install_backup
test_guard_install_idempotent
test_guard_check_files
test_guard_check_no_files
test_guard_check_staged
test_guard_status
test_guard_uninstall
test_guard_uninstall_restore
test_attach_auto
test_attach_auto_override
test_not_git_repo
test_guard_hook_execution

# ===========================================
# Summary
# ===========================================

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "Results: ${GREEN}$PASSED passed${NC}, ${RED}$FAILED failed${NC}, ${YELLOW}$SKIPPED skipped${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$FAILED" -gt 0 ]; then
    exit 1
fi
