# sanctum-oss

- **Source:** https://github.com/postrv/sanctum-oss
- **Encountered:** 2026-05-12, asked to evaluate against INTAKE
- **Verdict:** PR (extract credential patterns — landed 2026-05-12) + **new PR candidate** (4-ecosystem extension to `package-install-parser.ts` — opened 2026-05-26, see re-read addendum) + memory note (verification-discipline lesson, also recorded in [[reference-arbitersec-competitor]])

## 1. Core idea (one sentence)

A userland Rust daemon that watches Python site-packages for `.pth`-injection
supply-chain attacks, redacts ~37 credential shapes in agent stdin/stdout,
checks package names against npm/PyPI/crates.io registries to catch
slopsquatting, and meters LLM spend by MITM-proxying agent → model API
traffic.

## 2. Anatomy

```
crates/                                  (Cargo workspace, 8 crates, ~22.6k LOC)
├── sanctum-types/        IPC protocol, threat model, paths
├── sanctum-sentinel/     .pth watcher, credential-access watcher, network anomaly
├── sanctum-firewall/     37 cred regexes, Shannon entropy, hook handlers (claude.rs, …)
├── sanctum-budget/       LLM pricing tables + token-count parsers (deterministic)
├── sanctum-proxy/        HTTP MITM proxy for LLM API budget enforcement
├── sanctum-daemon/       Async event loop, Unix-socket IPC server
├── sanctum-cli/          Stateless CLI (~14 subcommands) over the socket
└── sanctum-notify/       macOS AppleScript / Linux notify-send wrappers
proofs/                   README + retained spec; live Kani proofs are inline
                          (#[cfg(kani)] in 6 files, 9 #[kani::proof] fns total)
```

**Load-bearing files:**

1. `crates/sanctum-firewall/src/patterns.rs` (1,269 LOC) — 37 `static_regex!(...)`
   patterns: OpenAI `sk-…`, Anthropic `sk-ant-…`, AWS `AKIA|ASIA…`, GitHub `ghp_…`,
   JWT, Stripe, Slack, npm/PyPI tokens, Vault, DigitalOcean, etc. ReDoS-safe
   (no lookahead). This is the file we'd actually borrow.
2. `crates/sanctum-sentinel/src/pth/analyser.rs` (1,091 LOC) — classifies every
   line of a `.pth` file as `benign | suspicious | malicious` using keyword
   heuristics for `import`/`exec`/`eval`. Pure code, no model.
3. `crates/sanctum-sentinel/src/pth/lineage.rs` — when a `.pth` appears, tries
   `/proc/<pid>/exe` to identify creator; flags creator-not-pip as suspicious.
   Fails open on macOS / sandboxed Linux.
4. `crates/sanctum-firewall/src/hooks/claude.rs` — five Claude Code hook handlers
   (`pre-bash`, `pre-write`, `pre-read`, `pre-mcp`, `post-bash`); each is a thin
   wrapper that IPCs to the daemon and emits `{decision, reason}` JSON.
5. `crates/sanctum-types/src/paths.rs` — `~/.sanctum/sanctum.sock` IPC contract.
   Same architectural shape as our `.interlinked/harness.sock`.

**Invocation:** `eval "$(sanctum init --shell zsh)"` autostarts the daemon on
shell launch; `sanctum hooks install claude` writes `~/.claude/hooks/*`.
Claude Code → hook bin → Unix socket → daemon → JSON decision back.

**End-to-end:** agent runs `npm install lodahs` → `pre-bash` hook → daemon
checks npm registry → name doesn't exist → block. Agent runs `pip install foo`
→ post-install, `notify` watcher sees a new `.pth` file → `analyser.rs`
classifies it → if malicious, `quarantine.rs` moves it aside. Agent calls
Anthropic API through `sanctum-proxy` → response parsed → token count added
to today's spend → if over budget, next call blocked.

## 3. Deterministic or agentic?

**Fully deterministic. Zero LLM calls.** `Cargo.toml` workspace deps are
`reqwest`/`tokio`/`hyper`/`regex`/`serde`/`notify` — no `anthropic`,
`openai`, `google-ai-rs`, or any inference SDK. `reqwest` is used only
outbound to proxy agent traffic and to hit npm/PyPI/crates.io registries
for slopsquatting checks. All threat decisions are regex + entropy +
keyword classifiers + pricing tables compiled into the binary.

**License: MIT** (confirmed in `LICENSE`). Code-borrow safe for either
the open CLI or the paid surfaces.

## 4. Substrate vs. surface

**Borrowable substrate (lane-3 candidates):**
- `patterns.rs` (37 cred regexes) — directly portable to a TS detection module.
- `entropy.rs` Shannon-entropy classifier (Kani-proven) — small enough to
  reimplement; useful for unknown-shape secret detection.
- `pth/analyser.rs` rule catalog — translatable to a Node check that scans
  `site-packages` after `pip install` (if we even want to expand into Python
  supply-chain).

**Daemon surface (not borrowable, but architecturally interesting):**
The daemon ↔ stateless-CLI-over-Unix-socket shape is exactly the same as
`.interlinked/harness.sock`. Two independent teams converged on the
same architecture for AI-agent gating — quiet confirmation that the
shape is right, not new information.

**Spend/MITM proxy (`sanctum-proxy`):** routes to lane 5. Spend metering is
deterministic, but it requires terminating TLS for every agent → LLM
request from the host. That's a multi-tenant feature, not a per-developer
CLI gate.

## 5. Lane

**Primary lane 2 (detection technique)** — the cred patterns and the
`.pth` keyword classifier are concrete, low-FP detectors that map cleanly
onto our pre-/post-tool checks.

**Secondary lane 3 (substrate)** — `patterns.rs` is small, MIT, and
self-contained; vendoring or porting is the action, not "be inspired by".

**Tertiary lane 5 (cloud-only fodder)** — `sanctum-proxy` (LLM-spend MITM)
belongs in the guardrails-cloud roadmap, not the CLI. Don't ship a local
MITM proxy.

## 6. Smallest spike (≤1 day)

Diff sanctum's 37 patterns against our existing secrets detector
(`src/harness/signatures.ts` — secrets family) and add only what's missing.

Concrete:
1. Grep our current secret/cred patterns; build a coverage table against
   the 37 names in `patterns.rs` (OPENAI / ANTHROPIC / AWS / GITHUB_PAT /
   GITHUB_FINE_GRAINED / GITLAB / SLACK_BOT / SLACK_USER / STRIPE / SENDGRID /
   JWT / BEARER / PRIVATE_KEY / DB_URL / NPM_TOKEN / PYPI_TOKEN / DO /
   DATADOG / AZURE_SAS / VERCEL / DOCKER_PAT / VAULT_TOKEN / …).
2. For each missing pattern: port the regex (it's a single line each) into
   the relevant check family, add ≥3 positive and ≥3 negative fixtures.
3. Run the recurrence scanner (`interlinked recurrence scan --record`) to
   see if any historical events would have triggered the new patterns;
   that's the gate for promoting to default vs. advisory.

Half-day, including tests. Anything bigger than "merge missing regexes"
is out of scope — the daemon, the proxy, and `.pth` analysis are
separate adoption decisions that should each get their own intake file
if they ever come up.

## 7. Artifact

PR (regex merge) + memory note (the verification-discipline observation
in §Notes — Kani inline-proof pattern is repo-craft worth recording).

## 8. Surface

interlinked-cli (cred patterns). `sanctum-proxy`/spend tracking is
guardrails-cloud fodder if we ever do it; not now.

## Notes

- **Quality bar far exceeds star count.** 1 GitHub star, 22.6k LOC of
  Rust, 9 inline Kani proofs (`#[kani::proof]` in `entropy.rs`,
  `mcp/policy.rs`, `pth/analyser.rs` ×3, `pth/quarantine.rs` ×2,
  `network/exfiltration.rs`, `budget/pricing.rs`), `deny.toml`, pinned
  `rust-toolchain.toml`. Reads like a planted seed of a paid product.
- **Inline-Kani pattern is borrow-worthy at the repo-craft level.** They
  keep `#[cfg(kani)]` blocks next to the code they verify; the
  top-level `proofs/` directory is just a README pointing at them.
  Worth remembering for any future formal-verification work we do on
  the harness's deterministic-only invariants. (We don't run Kani —
  this is "noted, not adopted".)
- **Marketing language vs. source.** README pitches "developer security
  daemon for the AI coding era / runtime integrity monitoring / AI
  credential firewall". Source is regex + filesystem watcher + heuristics.
  Less than the marketing implies, but better than the marketing implies
  *for us*: no hidden LLM-as-judge layer to route around. Same lesson as
  `codewiki.md` — read the load-bearing function, not the homepage.
- **"Runtime integrity" is reactive, not preventive.** `notify` crate
  (inotify/FSEvent) sees the bad write after it lands and then
  quarantines. No eBPF, no seccomp, no PTRACE. Honest about it
  (eBPF deferred to v0.5 per their network anomaly code). If you wanted
  pre-execution prevention you'd still need to write it yourself.
- **Parallel-architecture confirmation, not lesson.** Sanctum's
  `~/.sanctum/sanctum.sock` daemon ↔ stateless CLI is the same shape as
  `.interlinked/harness.sock`. Two teams reaching the same conclusion
  independently is a positive signal about that shape, but doesn't
  change anything we already do.

## Methodology notes

The agent that produced the first draft of this intake gave file paths
without the `crates/<crate-name>/` Cargo-workspace prefix
(e.g. `src/firewall/patterns.rs` instead of
`crates/sanctum-firewall/src/patterns.rs`). Worth flagging in INTAKE.md
that for Rust workspaces, full crate-prefixed paths are required —
without them, a future re-grep won't find the load-bearing files.
Not a rubric edit yet, just noting it here in case it recurs.

## Re-read addendum (2026-05-26)

Re-cloned at v0.5.0 (HEAD `7a08396`, `Stabilize daemon IPC e2e tests`, +5 days post-original-intake). Source re-read end-to-end. Three updates:

**Original credential-pattern PR landed.** The 20-pattern port + the `evaluator/write-content-guards.ts` exemption fix + `signatures.ts` updates went in during the May-12 sprint per the crash addendum below. Nothing new on that axis — closed.

**New PR candidate (open): 4-ecosystem extension to `src/harness/package-install-parser.ts`.** The May-12 intake didn't drill into `crates/sanctum-firewall/src/package_policy.rs` (2369 LoC at v0.5.0). Reading it now: Sanctum's slopsquatting parser covers **four ecosystems we don't** —

| Ecosystem | Commands Sanctum parses | Validity predicate | URL probe |
|---|---|---|---|
| NuGet | `dotnet add package`, `dotnet tool install`, `dotnet new install`, `dotnet workload install`, `nuget install` | `is_valid_nuget_package_name` (≤128 chars, no `..`, first alnum, charset `alnum + . - _`) | `api.nuget.org/v3-flatcontainer/{name}/index.json` |
| Maven | `mvn dependency:get -Dartifact=group:artifact[:version]`, `./mvnw`, `mvnw` | `is_valid_maven_coordinate` (must contain `:`, group must contain `.`) | `repo1.maven.org/maven2/{group}/{artifact}/maven-metadata.xml` |
| Gradle | `gradle build/test/check/dependencies/publish/run/--refresh-dependencies`, `./gradlew`, `gradlew` | (warn-only, no per-package extraction — Gradle resolves from `build.gradle(.kts)`) | n/a (plugin probe at `plugins.gradle.org/plugin/{name}` for named plugins only) |
| Docker | `docker pull`, image-tag analysis | (tag/registry validation rather than name validation) | n/a (warning surface, not block surface) |

Plus a meaningful **Homebrew extension** beyond what we cover: tap-trust list (`homebrew/core`/`homebrew/cask`/`homebrew/services`/`homebrew/bundle`), `warn_untrusted_taps`, `warn_no_quarantine` for casks, `block_external_formula_installs` (URL/path formula references), and `extract_homebrew_external_formula_refs` / `extract_homebrew_taps` / `extract_homebrew_tap_urls` / `extract_homebrew_package_taps` / `is_bare_homebrew_upgrade` / `is_homebrew_bundle_command` as named helpers. Worth a side audit of our current `brew`-parsing coverage.

**Spike (1 day, real PR):**
1. **Parser additions** (~3h, ~250 LoC): port NuGet (5 entry shapes) + Maven (`dependency:get`) + Gradle (resolve-command detection, warn-only) + Docker (`:latest` and untrusted-registry warnings) into `src/harness/package-install-parser.ts`. Mirror the validity-predicate shape, not the HTTP probe.
2. **Allowlist schema** (~1h): extend `.interlinked/package-allowlist.json` to accept `nuget`/`maven`/`gradle-plugin`/`docker` ecosystem keys (sha256 snapshot continues to work unchanged).
3. **Cold-fallback parity** (~2h): update `coldPackageInstallBlockReason` in `src/hook-entry.ts` and `inlinePackageInstallCheck` in `src/lib/hook-template-chunks/guards-inline.ts` per `project_hook_paths_two_implementations.md` — both implementations recognise the new ecosystems.
4. **Tests** (~2h): per-ecosystem positive + negative + URL-spec + custom-registry cases, daemon path and cold-fallback path both pinned.

**Hard out-of-scope for this spike (record + park):**
- **HEAD-probe registry-existence check.** Sanctum's `check_package_exists_with_timeout` makes a 5 s HTTP HEAD to the registry for `Exists`/`NotFound`/`CheckFailed`, fail-open on `CheckFailed`. This crosses our offline-first stance and "no fail-open on safety" stance (`feedback_safety_continuity.md` argues the opposite direction — fail-open *can* be right, but the safety-continuity tradeoff needs an explicit RFC, not a quiet inclusion in a parser PR).
- **Per-ecosystem `Config` struct** (allowlists, trusted prefixes, warn flags). Our allowlist is one JSON file; Sanctum's per-ecosystem TOML config is more granular but more surface area. Defer pending evidence the granularity buys something.

**New patterns to record (no action today):**

- **Integer-cents LLM-spend tracking (ADR-009).** `BudgetAmount` parses `"$50"` → `u64` cents at config load. Pricing tables: integer cents per million tokens. Cost = `(tokens * price + 999_999) / 1_000_000` with `saturating_mul`/`saturating_add`. State as JSON, 0o600. Float-free, drift-free, panic-free. Clean shape *if* Interlinked ever intercepts LLM calls — but the harness mediates hooks, not LLM API traffic. Sanctum is also still partly-wired here (ADR-017 phases this in v0.1 → v0.2 → v0.3). Parked.
- **22 numbered ADRs in `docs/ARCHITECTURE.md`.** Every design decision named, with "Context / Decision / Rationale" — including deferred ones (ADR-014 `secrecy` later, ADR-017 budget pipeline phased, ADR-019 macOS process-attribution best-effort, ADR-020 dead threat categories wired up). Borrowable as a *process*: our `docs/design/*.md` is informal-numbered, and several of our most-cited decisions (e.g. `feedback_harness_deterministic_only.md`, `feedback_posttooluse_stays_sync.md`) would benefit from this shape. Lightweight pattern note; not a process change today.
- **Threat-model-with-explicit-residual-risk-per-protection** (`docs/THREAT_MODEL.md`). 10 protections, each with a residual-risk paragraph naming what the protection *doesn't* cover (e.g. "On macOS, FSEvent is less granular than Linux's inotify. Process identification may be imprecise"). This is the most honest doc in the repo. Worth modelling for our pre/post cloud-check design memos.
- **CEL policy rules** (non-Turing-complete, no side effects, fixed context vars `tool_name` / `paths` / `payload_size`, three forms only). Cleaner shape for user-authored policy than embedding JavaScript. If `/enforce` ever surfaces user-writable rules beyond the JSON in `.interlinked/distilled-rules.overrides.json`, CEL is the reference target.

**Convergence still holds, restated:** Sanctum's `sanctum-types::ipc` (length-prefixed framing, 64 KB cap, 0o600 socket perms, NDJSON audit log) is the same shape as our `src/harness/server.ts` + `.interlinked/harness.sock` + activity/recurrence JSONL. The threat-ID + `sanctum fix` flow (SHA-256 content-addressed threat IDs + resolutions in a separate NDJSON log preserving the audit log's append-only integrity) is the same shape as our `interlinked recurrence` aggregator. Two independent implementations of these primitives is a strong signal the abstractions are right.

**Methodology note for this re-read:** the May-12 intake correctly named the borrowable detection technique (the 37 patterns) and explicitly drew a category line ("the daemon, the proxy, and `.pth` analysis are separate adoption decisions"). Re-reading 14 days later with the source in hand surfaces an *additional* borrowable detection technique that didn't get drilled into the first time — the per-ecosystem parsers. The rubric guidance "Resist scope creep *in the per-project file*. The template is intentionally one page" was followed correctly the first time — the right move was to come back and amend, not to over-extend the original draft. (This addendum is itself a small case study of the rubric working as designed.)

## Crash addendum (2026-05-12)

This intake and the accompanying source edits were lost in a system
crash mid-session. The 20-pattern port, the test cases, the bug-fix to
`evaluator/write-content-guards.ts`, and this doc all had to be
re-applied from conversation context. Two indirect findings during
recovery worth recording:

- The PreToolUse PI scan blocks edits to harness internals that
  legitimately contain PI strings (`signatures.ts`, the
  signatures-test file). Fix landed: path-based exemption via
  `isContentScanExempt` (test/spec/doc/fixture files) plus an
  `/harness/signatures.` entry in the existing harness-internals list in
  `checks/shared.ts`.
- The "non-determinism" of the Edit-block flap is daemon latency: when
  the daemon is busy enough to miss the hook's 500 ms socket timeout,
  the cold-fallback inline path silently allows content the daemon
  would block. Same input, different decisions — driven entirely by
  whether the daemon answers fast enough. The path-based exemption
  brings the two paths into agreement for the legitimate-fixture case;
  the broader latency story is a separate concern.
