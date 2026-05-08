# Plan: UBS-derived checks too heavy for the per-edit hook

## Context

Mining the **Ultimate Bug Scanner** (`reference-repos/ultimate_bug_scanner/`,
v5.0.7, ~1.9MB of bash + AST helpers across 10 languages) yielded ~130
novel pattern candidates we don't already implement. Most are
hook-feasible (regex or single-file AST, <50ms). This doc captures the
~25 that aren't — patterns that need cross-file dataflow, full-project
graphs, or external toolchains and therefore belong in a remote/cloud
analysis tier rather than the per-tool-use hook.

The hook-feasible subset is enumerated in the parent triage and lands
incrementally in `src/harness/checks/<family>.ts`. This doc is purely
for the deferred set.

Source files mined (line citations in this doc reference these):

- `modules/ubs-python.sh` (~11K lines of bash + embedded Python AST)
- `modules/ubs-js.sh` (~9.8K)
- `modules/ubs-rust.sh`, `ubs-golang.sh`, `ubs-java.sh`, `ubs-csharp.sh`,
  `ubs-swift.sh`, `ubs-cpp.sh`, `ubs-ruby.sh`, `ubs-elixir.sh`
- `modules/helpers/resource_lifecycle_{py,go,java,csharp}.{py,go}`
- `modules/helpers/type_narrowing_{ts,rust,csharp,swift,kotlin}.{js,py}`

## Why these are cloud-only

The harness PostToolUse soft ceiling is 15-30s shared across all checks
(`server.ts:2255`). PreToolUse is 500ms. That's enough budget for AST
walks of the file just edited but not for:

1. **Cross-file taint flow**: source in `routes/api.ts`, sink in
   `services/db.ts` — needs the whole project's call graph.
2. **External-toolchain checks**: cargo audit, ast-grep rule packs,
   bandit/mypy on Python — start time alone exceeds the budget.
3. **Whole-project AST helpers**: UBS's resource-lifecycle helpers walk
   every file to correlate `open()` with `close()` across modules.
4. **Heuristics with high cross-file FP** that are only useful when
   ranked against a project-wide baseline (e.g. "this file is the only
   one with raw SQL concat — investigate" vs "every file has it").

Server-tier execution (Worker + DO + R2) gives us minutes of budget,
shared trigram/AST indexes, and cross-file context. The right home is a
post-edit batch run keyed on the session, not the per-tool-use hook.

## Existing coverage to extend

We already have the bones for some of this:

- `src/harness/structural-checks.ts` — 25 dependency-aware checks,
  cross-file but limited to import graph + symbol resolution.
- `src/harness/impact-analysis.ts` — cross-file dependency tracking and
  breaking-change detection.
- `src/harness/taint-tracker.ts` — Public/Confidential/Secret
  classification and flow tracking. Currently single-file; the cloud
  tier is where it grows multi-file.
- `src/harness/error-history.ts` — error pattern memory; the cloud tier
  feeds it richer signals.

The cloud tier should reuse the `CheckRegistry` shape so verify can
fold cloud findings into its existing report — the surface stays one
report; only the producer changes.

## Tier 1 — Multi-file taint flow

UBS embeds taint analyzers inline in each language module. We already
do single-file taint in `taint-tracker.ts`; the missing piece is
multi-file source/sink propagation. These all share the same shape:
**source** (untrusted input) → **sanitizer** (validation/escape) →
**sink** (dangerous operation), with the chain potentially crossing
file boundaries.

| Pattern | Source examples | Sink examples | UBS cite |
|---------|----------------|---------------|----------|
| `taint_command_injection` | `req.body`, `argv`, `os.environ`, `input()` | `subprocess.*` w/ `shell=True`, `exec*`, `os.system` | ubs-python.sh:~2843, ubs-rust.sh C8 |
| `taint_sql_injection` | request data, `argv` | `execute*`, `raw`, `read_sql`, ORM `.query()` w/ string interp | ubs-python.sh:~3075, ubs-js.sh C7, ubs-golang.sh:5009+ |
| `taint_path_traversal` | request data, `argv`, env | `open`, `read`, `send_file`, `Path()`, `os.path.join` w/o `safe_join`/`secure_filename` | ubs-python.sh:~3295, ubs-go security |
| `taint_ssrf_outbound_url` | request data | `requests.*`, `urllib.open`, `http.Get`, `fetch`, `httpx` | ubs-python.sh:~3365, ubs-rust.sh C8, ubs-golang.sh C9 |
| `taint_prototype_pollution` | `req.body`, `req.query`, `req.params` | `Object.assign`, `_.merge`, `_.set` w/o `__proto__`/`constructor`/`prototype` filter | ubs-js.sh:5374-5576 |
| `taint_open_redirect` | `req.query`, `req.params`, `location.search` | `router.push`, `location.href = `, `res.redirect`, `Response.redirect` w/o same-origin/allowlist check | ubs-js.sh:5827-5997, ubs-python redirect, ubs-golang.sh C9 |
| `taint_host_header_url_injection` | `Host`, `X-Forwarded-Host` headers | absolute-URL string construction w/o allowlist | ubs-js.sh:5999-6208, ubs-golang.sh C9 |
| `taint_request_regex_redos` | request data | `re.compile/match/search`, `RegExp(...)` w/o `re.escape` | ubs-python.sh:~3165 |
| `taint_log_injection_crlf` | request headers | response header construction w/o CR/LF strip | ubs-golang.sh C9, ubs-java.sh C4 |
| `taint_credential_in_url` | request data | URL string with credentials embedded | ubs-rust.sh C8 |

**Implementation shape:** language-aware AST → call-graph builder
(reusing project-graph + cross-file-resolver) → source/sink rule pack
per language. Findings carry source-file:line, sink-file:line, and the
intermediate hops. Reference: UBS embeds ~150-200 line Python analyzers
inline in each module — we can lift the source/sink lists wholesale,
the call-graph traversal is ours.

**Why not in the hook:** crossing module boundaries means resolving
imports, which is a cache miss on the first edit of the session and a
~hundred-millisecond traversal even with a warm index. Stacking 10
taint families per edit would dominate the budget.

## Tier 2 — Whole-project resource lifecycle

UBS ships dedicated helpers (`modules/helpers/resource_lifecycle_*`)
that walk every file in the project, tracking acquire/release pairs
across functions and modules. We already have single-file lifecycle in
`checks/b-series.ts::checkLifecycleCleanup`; multi-file is the gap.

| Helper | What it tracks |
|--------|----------------|
| `resource_lifecycle_py.py` | file handles, sockets, `subprocess.Popen`, `asyncio.create_task` — acquire/release with context-manager awareness, return/yield escape detection |
| `resource_lifecycle_go.go` | `context.With*`/cancel, `time.NewTicker`/Stop, `time.NewTimer`/drain, `os.Open`/`sql.Open`/Close, mutex Lock/Unlock symmetry |
| `resource_lifecycle_java.py` | `FileInputStream`/`Statement`/`PreparedStatement`/`ResultSet`/`Connection` outside try-with-resources, executor services that never close |
| `resource_lifecycle_csharp.py` | same shape, C# `using` statements |

**Cross-file dimension:** acquire in `db.ts`, return handle, release in
`api.ts`. Single-file pass misses this; cross-file pass catches it.

**Implementation shape:** AST per file (cached), then a sweep that
joins acquire-call-sites with release-call-sites across the
import-resolved call graph. Output: list of resources with no
discoverable release path. Output severity: warning for default,
critical for shared-state (DB connection, mutex).

## Tier 3 — Semantic security checks

These use semantic context (variable name × operation) where the
signal-to-noise needs project-wide baseline to be useful. UBS runs
them globally and dedupes; per-edit they fire too noisily.

| Pattern | UBS cite | What |
|---------|----------|------|
| `noncrypto_rand_for_secrets` | ubs-rust.sh:7976, ubs-python sec | `rand::thread_rng()`, `Math.random()`, `random.random()`, etc. used in same expression as `token`/`secret`/`session_id`/`csrf` named target |
| `constant_time_secret_eq` | ubs-rust.sh:7987, ubs-python sec | `==`/`!=` on variables named like secrets — should be `crypto.timingSafeEqual` / `subtle.ConstantTimeCompare` / `secrets.compare_digest` |
| `jwt_validation_bypass` | ubs-rust.sh:7998, ubs-python sec | `insecure_decode`, `validate_exp=false`, `verify=False` on JWT decode — high-value but FP-prone w/o context |
| `cors_credentialed_wildcard` | ubs-rust.sh C8, ubs-go C9 | `Access-Control-Allow-Origin: *` together with `Access-Control-Allow-Credentials: true` in same response chain |
| `cookie_session_missing_flags` | ubs-go cookie security | session cookie set without `HttpOnly`+`Secure`+`SameSite` triple |

We have single-file approximations of some (e.g. cookie flags). The
cloud version threads the rule across handlers/middleware/configs that
live in different files.

## Tier 4 — Type-narrowing semantics

UBS ships per-language narrowing analyzers (`type_narrowing_*`). They
watch for guards that don't actually narrow what the agent thinks they
narrow:

- **TS**: `if (x !== null) { … x.foo }` followed by `x = …` then `x.foo`
  again — the guard is invalidated by reassignment.
- **Rust**: `if let Some(x) = opt { … }` followed elsewhere by
  `opt.unwrap()` on the same option — the agent's "I checked it"
  intuition is wrong.
- **C#**: `if (x != null) { … x?.foo }` — redundant null-conditional.
- **Swift**: `guard let x = opt else { return }` then `opt!` usage.

`type_narrowing_ts.js` is the most port-friendly — it uses TS compiler
API at edit time, which we already pull in for `tsc --noEmit`. Per the
helper recommendation in the mining report, the **TS narrowing case
can move to the hook tier** if we wire up the compiler-API integration
we already have for `tsc`. Other languages stay cloud-tier (they
require ast-grep or syn parsers we don't load locally).

## Tier 5 — External-toolchain orchestration

UBS Cat 20 (Python) wraps ruff/bandit/pip-audit/mypy/safety/detect-secrets;
Cat 12-14 (Rust) wrap clippy/audit/deny/udeps/outdated; Java wraps PMD/SpotBugs.
Most exceed our hook budget on cold start. The cloud tier is the right
place to:

1. Run the heavy linter once per push (rather than per edit) and surface
   diffs.
2. Maintain a baseline so only newly-introduced findings fire.
3. Cache results per content-hash so re-runs over unchanged files are free.

We already wrap `tsc`/`biome`/`oxlint`/`gitleaks`/`semgrep`/`dep-audit`
in `verify`. Server-tier additions worth considering: ruff (Python),
clippy (Rust), staticcheck (Go), PMD (Java), Brakeman (Ruby), Credo
(Elixir).

## Architecture

```
┌──────────────────────────┐         ┌────────────────────────────┐
│ Per-edit hook (existing) │         │ Server-side analysis tier   │
│ • Block decisions         │         │ (Worker + DO + R2)          │
│ • Single-file regex/AST   │         │                             │
│ • Diff-aware filtering    │   ──▶  │ • Cross-file taint flow     │
│ • <30s shared budget      │         │ • Multi-file lifecycle      │
└──────────────────────────┘         │ • Semantic security packs   │
            │                        │ • External-toolchain runs   │
            │ session events          │ • Per-content-hash cache    │
            ▼                        └────────────────────────────┘
   Server reports findings                       │
   into the same activity            ◀───────────┘
   stream the CLI consumes for       feeds back into
   `verify`                          error_history + recurrence
```

The CLI consumes server-tier findings via the existing
`POST /api/ui/call` proxy (or a new dedicated `/api/analysis/findings`
endpoint), so users see them in `interlinked verify` and the activity
feed. Determinism rule preserved: server-tier checks are also
deterministic (taint analyzers, AST helpers, external tools) — no LLM
inference on the analysis path.

## Sequencing

1. **Phase 0 (no new infra)**: ship the ~110 hook-feasible UBS picks in
   the per-edit pipeline. Expand `ubs-language-specific.ts`, add
   per-language family files where missing (`elixir.ts`, `csharp.ts`),
   register in `entries-warnings.ts` / `entries-errors.ts`.
2. **Phase 1 (server-tier scaffolding)**: stand up the analysis Worker
   that consumes session events and runs cross-file passes. Reuse the
   existing trigram index for source/sink discovery.
3. **Phase 2 (taint families)**: implement Tier 1 source/sink rule
   packs per language. Lift UBS's source/sink lists verbatim — they're
   the load-bearing curated content. Start with TS/Python (highest
   user surface area), then Go/Rust/Java.
4. **Phase 3 (lifecycle helpers)**: port the four `resource_lifecycle_*`
   helpers to TS. They're the highest-leverage helpers because the
   bug class (resource leak across modules) is universally relevant.
5. **Phase 4 (semantic security pack)**: Tier 3 patterns, with
   per-project baselining.
6. **Phase 5 (external toolchain orchestration)**: wrap ruff/clippy/etc.
   with content-hash caching.

Phases 2-5 are independent and can be parallelized once Phase 1 lands.

## Open questions

- **Cost model**: server-tier passes consume Worker CPU. Do we run them
  on every push, or only on `interlinked verify --deep`? Suggest:
  default off, opt-in via flag or `.interlinked/config.json` setting,
  with a cached results endpoint so the next CLI run is fast.
- **Rule provenance**: when we lift UBS's source/sink lists, do we
  attribute? UBS is MIT+rider-licensed (per `LICENSE`). We attribute
  in code comments and in this doc; that's adequate for MIT.
- **Baseline storage**: per-project baseline of "known findings" lives
  where? Suggest the existing reservation/recurrence DO scope, with the
  server already tracking session-level state.
- **Cross-language unification**: many Tier 1 patterns are the same
  shape across languages. Do we register one generic rule with
  per-language source/sink tables, or N per-language rules? The first
  scales better; the second ships faster. Probably ship per-language
  first, refactor when the third language lands.
