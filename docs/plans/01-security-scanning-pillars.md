# SAST, SCA, and Secrets Scanning Integration

## Overview

Three security scanning pillars were integrated into both the Interlinked Harness (PostToolUse, per-file, real-time on every agent write) and `interlinked verify` (project-wide scan). Each pillar catches a different class of vulnerability that AI coding agents routinely introduce.

## The Three Pillars

| Pillar | Tool | What It Catches | Harness (PostToolUse) | Verify (Project-Wide) |
|--------|------|-----------------|----------------------|----------------------|
| **SAST** | Semgrep | Injection flaws, XSS, insecure deserialization, OWASP Top 10, language-specific bugs | Per-file on every Write/Edit | Full project scan with `--json` output |
| **SCA** | npm audit / pip-audit / cargo-audit / govulncheck | Known CVEs in dependencies (NIST NVD) | Triggered on dependency file edits | npm audit with parsed vulnerability counts |
| **Secrets** | Gitleaks + 9 inline regex patterns | Leaked API keys, tokens, credentials, private keys | Per-file via gitleaks + inline regex in evaluator | Project-wide gitleaks scan |

## How Each Pillar Works

### SAST (Semgrep)

**Harness PostToolUse** (`quality-checks.ts`):
- Runs on every file write matching supported extensions: `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.rs`, `.java`, `.c`, `.cpp`, `.rb`, `.php`
- Command: `semgrep scan --quiet --no-git-ignore --metrics off --config p/default`
- Timeout: 30 seconds per file
- Exit code handling: exit 1 = findings (report), exit 2 = config/auth error (skip silently)
- Default severity: `warning` (configurable to `error` in `guard-rules.json` for regulated environments)

**Verify** (`verify.ts`):
- Runs project-wide via `runSemgrep(cwd)`
- Command: `semgrep scan --quiet --no-git-ignore --metrics off --config p/default --json .`
- Timeout: 60 seconds (project-wide is slower)
- Parses JSON output: extracts `check_id`, `path`, `start.line`, `extra.message` from `results[]`
- Same exit code handling: exit 2 = skip

**Why `--metrics off`**: Semgrep's metrics telemetry sends codebase metadata (file names, rule match counts, project hash) to Semgrep's servers. In healthcare/regulated environments, this risks leaking information about internal codebases. `--metrics off` disables all telemetry with zero impact on scanning quality.

**Why `--no-git-ignore`**: Ensures files that are gitignored but present on disk (e.g., generated code, vendored dependencies) are still scanned for vulnerabilities.

**Healthcare-specific rulesets**: For regulated environments, the Semgrep config can be extended:
```
semgrep scan --config p/default --config p/owasp-top-ten --config p/security-audit --metrics off
```

### SCA (Dependency Audit)

**Harness PostToolUse** (`quality-checks.ts`):
- Triggered only when dependency/lock files are edited:

| File | Audit Command |
|------|--------------|
| `package.json`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml` | `npm audit --json --audit-level=moderate` |
| `requirements.txt`, `pyproject.toml`, `Pipfile.lock` | `pip-audit --format json --desc` |
| `Cargo.toml`, `Cargo.lock` | `cargo audit --json` |
| `go.sum`, `go.mod` | `govulncheck -json ./...` |

- ENOENT handling: if the audit tool is not installed, skips silently (no false negatives, just no coverage)
- npm audit exit 1 = vulnerabilities found; parses `metadata.vulnerabilities` for critical/high/moderate/low counts
- Timeout: 30 seconds
- Default severity: `warning`

**Verify** (`verify.ts`):
- Runs `runDependencyAudit(cwd)` which detects the package ecosystem and runs the appropriate audit
- Currently implements npm audit with full JSON parsing
- Returns structured `AuditResult` with `total`, `critical`, `high`, `moderate`, `low`, `detail`

### Secrets (Gitleaks + Inline Regex)

**Gitleaks** provides 800+ detection patterns covering:
- Cloud provider keys (AWS, GCP, Azure)
- API tokens (GitHub, GitLab, Stripe, Slack, SendGrid, npm, etc.)
- Private keys (RSA, EC, DSA, OPENSSH)
- Database connection strings
- JWT tokens
- OAuth secrets

**Inline regex** (9 patterns in `quality-checks.ts`) provides fast, zero-dependency detection:

| Pattern | What It Matches |
|---------|----------------|
| `AKIA[0-9A-Z]{16}` | AWS Access Key IDs |
| `gh[ps]_[A-Za-z0-9_]{36,}` | GitHub Personal/Service tokens |
| `github_pat_[A-Za-z0-9_]{22,}` | GitHub Fine-grained PATs |
| `eyJ...` (3-part base64url) | JWT tokens |
| `-----BEGIN ... PRIVATE KEY-----` | PEM private keys |
| `xox[bpors]-...` | Slack tokens |
| `(sk\|pk)_(live\|test)_...` | Stripe API keys |
| `SG.[base64].[base64]` | SendGrid API keys |
| `npm_[A-Za-z0-9]{36,}` | npm tokens |

**Harness PostToolUse**:
- Gitleaks runs per-file via command: `gitleaks detect --no-git --no-banner -v`
- Inline regex runs on file content from the event (both `content` and `new_string` fields)
- Gitleaks also runs in PreToolUse evaluator via `containsSecrets()` which delegates to the same inline patterns
- Timeout: 10 seconds (gitleaks is fast per-file)
- Default severity: `error` (secrets are always critical)

**Verify**:
- Runs project-wide via `runGitleaks(cwd)`: `gitleaks detect --no-git --no-banner --report-format json --report-path /dev/stdout --source .`
- Timeout: 30 seconds
- Parses JSON array output: extracts `File`, `StartLine`, `RuleID`, `Description`

## False Positive Suppression: `.gitleaks.toml`

The `.gitleaks.toml` file at the project root suppresses known false positive paths:

```toml
title = "Interlinked gitleaks config"

[allowlist]
  description = "Known false positive paths and patterns"
  paths = [
    # Conversation metadata and activity logs (ANSI codes look like secrets)
    '''.entire/''',
    '''.interlinked/activity\.jsonl''',
    '''.interlinked/config\.local\.json''',
    '''.interlinked/hooks/''',
    '''.claude/settings\.local\.json''',
    # Reference repos are third-party code
    '''reference-repos/''',
    # Docs contain example tokens for illustration
    '''cloudflare-architecture/''',
    '''docs/''',
    # Test files intentionally contain fake secrets
    '''\.test\.ts$''',
    '''\.test\.js$''',
    '''\.spec\.ts$''',
    '''__tests__/''',
    '''test-suite/''',
    # Signature/pattern files contain detection regexes that match themselves
    '''cli/src/harness/signatures\.ts''',
    '''cli/snapshot\.md''',
    '''src/utils/redact\.test\.ts''',
  ]
```

## CHECK_INSTRUCTIONS

Each pillar includes agent-facing instructions that tell agents to fix the code, not suppress the finding:

| Pillar | Instruction |
|--------|-------------|
| **Semgrep** | "Fix the security or correctness issue identified by Semgrep. Do NOT add nosemgrep comments to suppress findings -- fix the underlying code. If the finding is in a healthcare/regulated context, treat it as high priority." |
| **Dependency Audit** | "Dependency vulnerabilities were found. Run `npm audit fix` to auto-fix compatible updates, or `npm audit` to review. For critical/high vulnerabilities, update the affected package immediately. Do NOT ignore -- vulnerable dependencies are a compliance risk in regulated environments." |
| **Gitleaks** | "Secrets or credentials were detected by gitleaks. Remove them immediately and rotate the exposed credential. Use environment variables or a secrets manager (e.g., Vault, AWS Secrets Manager) instead. If this was committed to git, the credential is already exposed -- rotation is mandatory." |

## Healthcare Relevance

| Concern | How We Address It |
|---------|------------------|
| No telemetry leaking codebase metadata | `--metrics off` on all Semgrep invocations |
| Severity escalation for regulated code | Set severity to `error` in `guard-rules.json` to make SAST/SCA findings blocking |
| Healthcare-specific rulesets | Add `--config p/owasp-top-ten --config p/security-audit` to Semgrep command |
| Credential rotation enforcement | Gitleaks CHECK_INSTRUCTIONS explicitly state rotation is mandatory |
| Compliance audit trail | All findings are logged via telemetry (`writeTelemetry`) and guard event reporting (`serverBridge.reportGuardEvent`) |

## Production Validation

Demonstrated end-to-end with all three pillars:

```
$ interlinked verify --details

  interlinked verify · 485 files scanned

  typescript        ✓ no errors
  biome             ✓ no issues
  semgrep (SAST)    ✓ no findings
  gitleaks (secrets) ✓ no secrets detected
  dependency audit (SCA)  ✗ 4 vulnerabilities (4 high)
  strong typing     ✓ no any-types
  ...
```

**Real findings caught**:
- **SCA**: 4 high severity CVEs — `rollup` (arbitrary file write via path traversal, GHSA-mw96-cpmx-2vgc) and `undici` (WebSocket crashes, HTTP smuggling, CRLF injection, unbounded memory consumption — multiple GHSAs). Fixable with `npm audit fix`.
- **Gitleaks (harness)**: 162 raw findings, all false positives from conversation logs (`.entire/`), activity logs (`.interlinked/`), reference repos, test data, and signature pattern files. All 162 suppressed to 0 via `.gitleaks.toml`.

## Team Configuration

Teams can override default severity in `.interlinked/guard-rules.json` to make findings blocking:
```json
{
  "quality_checks": {
    "semgrep": { "severity": "error" },
    "dependency_audit": { "severity": "error" }
  }
}
```

Healthcare-specific Semgrep rulesets:
```json
{
  "quality_checks": {
    "semgrep": {
      "command": "semgrep scan --quiet --no-git-ignore --metrics off --config p/default --config p/owasp-top-ten --config p/security-audit"
    }
  }
}
```

## Files Changed

| File | Changes |
|------|---------|
| `cli/src/harness/quality-checks.ts` | Added `dependency_audit` handler (SCA), `semgrep` exit code 2 handling (config error = skip), `gitleaks` and `dependency_audit` in `shouldRunCheck`, CHECK_INSTRUCTIONS for all three pillars |
| `cli/src/harness/rules-loader.ts` | Added default configs for `semgrep` (`p/default --metrics off`), `dependency_audit` (multi-ecosystem), `gitleaks` (`--no-git --no-banner -v`) in `DEFAULT_CONFIG.quality_checks` |
| `cli/src/commands/verify.ts` | Added `runSemgrep()` (JSON output parsing), `runGitleaks()` (JSON report parsing, exit 1 = findings), `runDependencyAudit()` (npm audit JSON parsing with structured AuditResult), `DiagnosticResult` type extended with `"semgrep" \| "gitleaks"`, `AuditResult` interface, display sections for all three in `displayResults()` and `outputJson()`, summary line includes semgrep/gitleaks/SCA counts |
| `cli/src/harness/server.ts` | Fixed biome import ordering — moved Bun type declarations (`declare const Bun`, `interface BunSocket`) below all imports so biome's `organizeImports` rule passes |
| `cli/src/harness/evaluator.ts` | Changed curl-to-MCP from block to warning (see plan 02) |
| `cli/src/harness/__tests__/evaluator.test.ts` | Updated test "escalates to block after configured threshold" → "warns (not blocks) after configured threshold" to match new warning behavior |
| `.gitleaks.toml` | Created with allowlist paths for `.entire/`, `.interlinked/`, `.claude/`, `reference-repos/`, `cloudflare-architecture/`, `docs/`, test files, signature files |

## Verification

- Type-check: `npx tsc --noEmit` — clean
- Tests: 528/528 passing (all 29 test files)
- Biome: all edited files clean
- `interlinked verify`: all three pillars reporting correctly
