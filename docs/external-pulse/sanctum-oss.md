# sanctum-oss

- **Source:** https://github.com/postrv/sanctum-oss
- **Encountered:** 2026-05-12, asked to evaluate against INTAKE
- **Verdict:** PR (extract credential patterns) + memory note (verification-discipline lesson)

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
