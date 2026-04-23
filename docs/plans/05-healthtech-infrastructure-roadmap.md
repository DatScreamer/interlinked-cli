# HealthTech Infrastructure Roadmap -- Mapping Role Requirements to Interlinked

## Overview

This document maps the 10-item infrastructure list from the HealthTech role to Interlinked's existing capabilities and identifies what was built this session versus what needs to be built next.

## The 10-Item Infrastructure Map

| # | Infrastructure Item | Where It Maps | Status | Key Components |
|---|-------------------|--------------|--------|----------------|
| 1 | **Dev environment bootstrap** | CLI (`interlinked bootstrap`) | Planned | One-command setup: install hooks, configure server, create workspace, install dependencies |
| 2 | **CI/CD quality gates** | Both Harness + CLI | Partial | `interlinked verify --json` IS the CI gate; returns exit code + structured JSON for CI pipelines |
| 3 | **Pre-commit hooks** | CLI (Harness) | **Done** | Harness IS the hook system: PreToolUse blocks, PostToolUse feedback, 66 guard rules, SAST/SCA/secrets |
| 4 | **Test harness + coverage** | Harness | Partial | `affected_tests` check exists (vitest --related); needs coverage threshold enforcement |
| 5 | **Regression test suite** | Verify | Partial | `test_regressions` check exists (detects skipped/disabled tests); needs critical-path runner |
| 6 | **Audit trail** | MCP Server (DO/SQLite) | Planned | Extend with immutable `audit_log` table; feeds from taint tracking, guard events, file reservations |
| 7 | **Compliance docs** | MCP Server | Planned | Generate from live data: workspace_members, roles, messages, file_reservations, agent_activity |
| 8 | **Staging env** | CLI | Partial | `interlinked verify <url>` already clones/scans remote repos; needs environment promotion workflow |
| 9 | **API integration sandbox** | MCP Server (Code Mode) | Partial | V8 isolates exist; needs FHIR/Stripe/scheduling SDK helpers for healthcare-specific integrations |
| 10 | **Sprint infra** | MCP Server | Partial | tasks, task_events, task_dependencies tables exist; needs sprint boundaries and velocity tracking |

## What Was Built This Session

### Security Scanning Pillars (Items 2, 3)

| What | Where | Details |
|------|-------|---------|
| **SAST (Semgrep)** | Harness PostToolUse + Verify | Per-file scanning on every agent write; project-wide scan in verify; `--metrics off` for healthcare compliance |
| **SCA (npm audit)** | Harness PostToolUse + Verify | Triggered on dependency file edits; supports npm/pip/cargo/go ecosystems; parsed vulnerability counts |
| **Secrets (gitleaks)** | Harness PostToolUse + Verify | 800+ detection patterns; per-file in harness, project-wide in verify; `.gitleaks.toml` false positive suppression |
| **`.gitleaks.toml`** | Project root | False positive suppression for conversation logs, test files, reference repos, signature pattern files |
| **server.ts import fix** | Harness | Fixed biome import ordering violation (alphabetical sort required) |
| **curl-to-MCP: block -> warning** | Evaluator | Downgraded from block to warning; blocking curl-to-localhost was too aggressive for dev workflows |

**Verification**: All 528 tests passing, type-check clean.

### Files Changed

| File | Change |
|------|--------|
| `cli/src/harness/quality-checks.ts` | Added `dependency_audit` handler, `semgrep` exit code handling, `gitleaks` shouldRunCheck, CHECK_INSTRUCTIONS for all three pillars |
| `cli/src/harness/rules-loader.ts` | Added default configs for `semgrep`, `dependency_audit`, `gitleaks` in DEFAULT_CONFIG |
| `cli/src/commands/verify.ts` | Added `runSemgrep()`, `runGitleaks()`, `runDependencyAudit()` for project-wide scanning |
| `cli/src/harness/server.ts` | Fixed biome import ordering |
| `cli/src/harness/evaluator.ts` | curl-to-MCP changed from block to warning |
| `cli/src/harness/generic-checks.ts` | Supporting changes for verify integration |
| `.gitleaks.toml` | Created false positive suppression config |

## What to Build Next (Prioritized for Healthcare)

### Priority 1: Audit Trail Infrastructure (Item 6)

**Why first**: Healthcare compliance (HIPAA, SOC 2) requires immutable audit trails. This is a regulatory table-stakes requirement, not a nice-to-have.

**What to build**:
- Immutable `audit_log` table in Workspace DO SQLite
- Feeds from: taint tracking events, guard block/allow decisions, file reservations, agent registrations
- Fields: timestamp, agent_name, action, resource, decision, reason, sensitivity_level, session_id
- Append-only (no UPDATE/DELETE permissions on this table)
- Export endpoint for compliance reporting

### Priority 2: Coverage Threshold Enforcement (Item 4)

**Why second**: The `affected_tests` check already runs tests related to edited files. Adding coverage threshold enforcement completes the testing story.

**What to build**:
- Parse coverage output (lcov/istanbul) after `affected_tests` runs
- Block if coverage drops below configurable threshold (e.g., 80%)
- Report coverage delta (before/after the edit)
- Configuration in `guard-rules.json`: `{ "coverage_threshold": 80, "coverage_format": "lcov" }`

### Priority 3: Cursor Hook Support

**Why third**: Near-zero effort, immediately doubles our agent CLI coverage.

**What to build**:
- Cursor detection in `cli/src/lib/hooks.ts`
- Cursor normalizer (identity function -- same format as Claude Code)
- Test with Cursor's `hooks.json` configuration
- Estimated: 1-2 hours

### Priority 4: Copilot Hook Support

**Why fourth**: Guardable (deny-only), expands coverage to GitHub Copilot users.

**What to build**:
- Copilot detection and normalizer in `hooks.ts`
- Map Copilot's deny response format
- Accept PostToolUse is informational only
- Estimated: 4-8 hours

### Priority 5: Sondera Option A

**Why fifth**: Install alongside harness for behavioral guardrails + immediate Cursor/Copilot coverage via pre-built Rust binaries.

**What to build**:
- Install `sondera-coding-agent-hooks` binary
- Configure both hooks in agent settings
- Document complementary coverage model
- Zero code changes in Interlinked

### Priority 6: Cedar Policy Evaluation

**Why sixth**: Only if guard rules don't scale beyond 100+ rules. Current 66 rules are manageable in JSON format.

**What to build**:
- Cedar policy translations of all 66 guard rules
- Cedar evaluation engine replacing `matchesRule()` in evaluator
- Policy testing framework
- Formal verification of policy completeness

## Key Insight

> "30-40% independent coding" means 60-70% is making senior engineers more productive. Lead with infrastructure, not features.

The HealthTech role description emphasizes infrastructure that makes the entire engineering team more productive:

| Activity | % of Role | Interlinked Coverage |
|----------|-----------|---------------------|
| **Infrastructure & tooling** | 60-70% | CI/CD gates (verify), pre-commit hooks (harness), test harness (affected_tests), audit trail (planned), compliance docs (planned) |
| **Independent coding** | 30-40% | Code Mode SDK (V8 isolates), multi-agent orchestration, task management |

The security scanning pillars built this session are squarely in the 60-70% -- they make every engineer's agent-assisted workflow safer and more compliant, without requiring any individual engineer to configure or maintain security tooling.

## Demonstrated `interlinked verify` Output (This Session)

```
$ interlinked verify --details

  interlinked verify · 485 files scanned

  typescript          ✓ no errors
  biome               ✓ no issues
  semgrep (SAST)      ✓ no findings
  gitleaks (secrets)   ✓ no secrets detected
  dependency audit (SCA)  ✗ 4 vulnerabilities (4 high)
  strong typing       ✓ no any-types
  suppressions        ✓ no suppression comments
  large files         ! 37 files over 800 lines
  json validity       ✓ all JSON files valid
  phantom imports     ✓ all imports resolve
  console statements  ! 117 console.log/debug/info in 24 files
  silent catches      ! 72 empty catch blocks in 21 files
  test regressions    ! 4 skipped/todo tests in 1 files
  env/config integrity ! 45 undocumented env vars in 39 files
  mock drift          ! 1 stale mock references in 1 test files
  incomplete renames  ✓ no orphaned string references

  0 / 485 files flagged · 4 dep vulnerabilities
```

## Related Plan Documents

- [01-security-scanning-pillars.md](01-security-scanning-pillars.md) — SAST, SCA, Secrets implementation details
- [02-pretooluse-guard-catalog.md](02-pretooluse-guard-catalog.md) — Complete block/warning catalog
- [03-multi-agent-cli-support.md](03-multi-agent-cli-support.md) — Agent CLI hook matrix and integration plan
- [04-sondera-integration.md](04-sondera-integration.md) — Sondera evaluation and recommendations
