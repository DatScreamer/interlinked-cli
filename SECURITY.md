# Security policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.x     | ✅ Current development line. Security fixes land on main and ship in the next patch release. |

While the project is in `0.x`, treat every minor version as potentially
breaking and pin carefully. Security fixes will be backported to the most
recent minor release only.

## Reporting a vulnerability

**Do not open a public GitHub issue for security reports.** Use one of:

1. **GitHub Security Advisory** (preferred):
   <https://github.com/QuentinCody/interlinked-cli/security/advisories/new>
   — lets us coordinate a private fix, request a CVE, and credit you in
   the advisory.
2. **Email**: `quentincody@gmail.com` with subject line prefix
   `[interlinked-cli security]`. We'll acknowledge within 72 hours.

Please include:

- A description of the vulnerability
- Steps to reproduce (a minimal repro is always best)
- Affected versions (if known)
- Suggested mitigation (if you have one)
- Whether you'd like public credit when the advisory publishes

## Scope

In scope:

- The CLI binary (`interlinked`)
- The local harness server and its guard rules
- The generated hook script (`.interlinked/hooks/interlinked-activity.mjs`)
- Any code path that reads untrusted input (hook-event JSON, server
  responses, file contents during scans)
- Supply-chain concerns (typosquat risk, dependency integrity)

Out of scope:

- Vulnerabilities that require an attacker to already have code execution
  on the user's machine
- Misconfigurations in user-supplied hooks or rules
- Third-party dependencies with their own security reporting channels
  (please report to them first)
- Any issue that depends on disabling the harness

## What to expect

- **Acknowledgement**: within 72 hours of receiving the report.
- **Triage**: within 7 days, we'll share a preliminary assessment.
- **Fix timeline**: depends on severity. Critical issues get same-week
  fixes; lower-severity ones align with the next scheduled release.
- **Disclosure**: coordinated. We prefer to publish an advisory at the
  same time a patched release ships.

## Hardening guidance for users

- Install from npm with `--ignore-scripts` if you're running in a CI
  environment that doesn't need install-time scripts (this package has
  no install-time scripts, but the flag is a belt-and-suspenders habit).
- Pin `interlinked-cli` to a specific version in your lockfile; don't use
  floating ranges for a tool that writes to your tree.
- Keep `.interlinked/config.local.json` out of version control — it's
  gitignored by default, but double-check.
- Review guard-rule overrides (`.interlinked/guard-rules.local.json`) in
  PRs as carefully as source code — a relaxed rule is a privileged change.
