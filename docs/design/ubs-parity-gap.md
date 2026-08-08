# UBS parity gap — measured

Status: measurement only (per task scope — no checks were implemented as part of
this analysis). This supersedes the informal "~130 novel candidates" estimate in
`docs/design/harness-ubs-cloud-checks-plan.md` with a counted, cited burn-down.

## 1. Method

- Cloned `github.com/Dicklesworthstone/ultimate_bug_scanner` fresh (not the
  `reference-repos/` copy referenced by the older doc — that path no longer
  exists locally) to `scratch/ubs-parity/ubs` (gitignored).
- **Commit analyzed: `5bd6be2ce7c02a2d1eda74656edb3f9920652f10`** (2026-08-04),
  tag `VERSION` = **5.3.8**. The older plan doc cites "v5.0.7" — UBS has moved
  on since that doc was written; this analysis is against current upstream.
- Counted UBS's raw checks mechanically: each language module (`modules/ubs-*.sh`)
  reports one finding per `print_subheader "..."` call inside a `CATEGORY N:`
  block; the C# module (`ubs-csharp.sh`) uses a different idiom (`search '...'`
  regex calls plus 7 dedicated helper functions) since it never adopted the
  `print_subheader` convention the other 9 modules share.
- Extracted every subheader/check title with its source line
  (`scratch/ubs-parity/subheaders-with-category.txt`, `csharp-checks.txt`),
  then manually clustered near-identical titles across languages into
  **distinct bug classes** (e.g. "Archive extraction path traversal" appears
  in 7 modules verbatim or near-verbatim — one class, not seven).
- Cross-referenced our own inventory via `npx tsx src/index.ts harness checks`,
  `src/harness/check-registry/**`, `src/harness/checks/**`, and
  `src/harness/language-profiles-data.ts`, reading detector source (not just
  ids) wherever a semantic match was plausible but not obvious from the name.
- The distinct-class count and the COVERED/PARTIAL/MISSING calls below are a
  **manual clustering of check titles**, not a formal taxonomy — labeled
  ESTIMATE where precision isn't achievable. The raw counts and the
  per-language-scope claims (which extensions a given one of our detectors
  gates on) are exact — verified by reading the gating code, not guessed.

## 2. The four headline counts

| Count | Value | Confidence |
|---|---|---|
| **UBS raw pattern count** | **760** | Exact (mechanical `print_subheader`/`search` count) |
| **UBS distinct bug classes** (deduped across languages) | **≈108** | Estimate — manual title clustering |
| **Ours covering a UBS class** (COVERED + PARTIAL) | **≈58 of 108** (~36 COVERED, ~22 PARTIAL) | Estimate, same methodology |
| **Our total check inventory** | **378** (253 inline + 23 sequence + 25 structural + 33 tool + 29 suggestion + 11 behavioral + 5 spec-ledger) | Exact — `interlinked harness checks` |

**Read the 760 vs 378 gap carefully — it is not what it looks like.** Our 378
includes ~230 checks that have no UBS counterpart at all (test-hygiene,
spec-ledger, agent-laziness/agent-clarity, taste/DRY/design-slop, endpoint
tenant-isolation, cognitive/cyclomatic/CRAP ratchets — an entire universe of
agent-authored-code-specific checks UBS doesn't attempt). The honest
comparison is class-for-class: **≈108 UBS classes, ≈58 of which we cover in
some language**, not 378 vs 760.

### A correction the raw count surfaced

`modules/ubs-java.sh` has a `if false; then ... fi` block starting at line
3997, explicitly commented **"The remainder of this file is an accidental
duplicated category tail. Keep it parsed for now, but never execute it so
counts are not multiplied."** Categories 23–100 (`CATEGORY 23: RESOURCE
SAFETY…` through `CATEGORY 100: AST-GREP RULE PACK…`) are dead, unreachable
duplicates of categories 7–22. Naive `grep -c print_subheader` on that one
file returns 187; only **62 are live**. This is folded into the 760 total
above (i.e. 760 already excludes the 125 dead Java rows) — a naive count
across all 10 modules would read **885**, ~16% inflated by one file's bug.

### Raw count by module (live checks only)

| Language | Raw checks | Method |
|---|---:|---|
| Python | 96 | `print_subheader` |
| JS/TS | 116 | `print_subheader` |
| Java | **62** (125 more exist but are dead code — see above) | `print_subheader`, pre-`if false` only |
| Go | 100 | `print_subheader` |
| Rust | 75 | `print_subheader` |
| C++ | 52 | `print_subheader` |
| Swift | 69 | `print_subheader` |
| Ruby | 68 | `print_subheader` |
| Elixir | 72 | `print_subheader` |
| C# | ~50 | 43 `search '...'` regex checks + 7 dedicated helper functions (different idiom, no `print_subheader`) |
| **Total** | **760** | |

## 3. Our coverage, structurally

Two facts drive most of the gap, and neither is about missing individual
patterns — they're missing *language surfaces*:

**Three of UBS's ten languages have zero dedicated detectors in this repo:
Ruby, Elixir, C#.** Verified three ways: no check id starts with a
Ruby/Elixir/C#-specific prefix (compare `ubs_java_*`, `ubs_rust_*`,
`ubs_go_shell_injection`, `swift_*` — 20+ ids); `src/harness/language-profiles-data.ts`
has no `.rb`/`.ex`/`.exs`/`.cs` extension mapping at all (its `LANGUAGE_EXTENSION_MAP`
covers `.py .js .ts .go .java .rs .swift .c .cpp` and friends only); and the
UBS-derived detector modules are explicitly extension-gated (e.g.
`checks/ubs-language-specific/_shared.ts` exports only `isPyFile`/`isJsTsFile`,
`checks/archive-extract.ts` gates on `isPy`/`isJs` only,
`checks/ubs-language-specific/division-by-variable.ts` imports only
`isJsTsFile`/`isPyFile` with a comment reading *"extending the allow-list to
`.kt` / `.rb` / `.cs` is a one-line edit"* — never done). That's **190 of the
760 raw UBS checks (25%)** in languages we don't parse at all, though most of
the underlying bug *classes* (SQL injection, hardcoded secrets, weak crypto)
already have a class-level entry via another language — the gap there is
language *breadth*, not class *novelty*.

**Even within covered languages, most detectors are gated to 1–5 of the 10
extensions**, not applied broadly. Two verified examples:
`ubs_sql_string_concat` (`checks/ubs-language-specific/cross-language-checks.ts:23`)
covers `.ts .tsx .js .jsx .mjs .cjs .py .go .rs .swift` — 5 languages — but not
Java, C/C++, Ruby, Elixir, C#, despite UBS running SQL-injection-shaped checks
in Java (Cat 13), C# (helper), and implicitly Ruby/Elixir (raw-SQL/Ecto
fragment interpolation). `ubs_archive_extract_traversal`
(`checks/archive-extract.ts:34`) covers only `.py` and JS/TS, versus UBS's
zip-slip check running in 7 of 10 modules (golang, elixir, swift, python,
ruby, cpp, java) plus a C# helper.

**External-toolchain wrapping (UBS Tier 5) is solid for JS/Python/Rust/Go/C,
absent for Ruby/Elixir/Java/C#/Swift.** `src/harness/check-metadata/quality.ts`
wraps `ruff_lint`/`ruff_format`/`python_typecheck` (Python), `cargo_check`/
`cargo_clippy`/`rustfmt_check` (Rust), `go_build`/`golangci_lint` (Go),
`c_compile`/`clang_tidy` (C/C++), `eslint`/`biome_lint`/`typescript` (JS/TS),
plus `gitleaks`/`semgrep`/`dependency_audit`/`shellcheck`/`actionlint`/
`hadolint` generically. There is no `rubocop`/`brakeman`/`bundler_audit`
(Ruby), no `credo`/`dialyzer`/`sobelow`/`mix_audit` (Elixir), no Maven/Gradle
build-health or PMD/SpotBugs wrapper (Java), no `dotnet build/test/format`
(C#). Swift is the one exception where the *strategy* differs rather than
being absent: instead of wrapping SwiftLint/SwiftFormat/xcodebuild/Periphery
as external tools, we hand-ported ~20 `swift_*` inline heuristic checks
(`checks/swift-*.ts`) — arguably an adequate substitute, not a gap.

## 4. MISSING classes (no coverage in any language)

"hook-feasible" = plausible single-file regex/AST, <50ms. "cloud-tier" = needs
cross-file dataflow, a whole-project graph, or an external toolchain per this
repo's own `docs/design/harness-ubs-cloud-checks-plan.md` criteria.

| Class | What it catches | UBS source (file:line, representative) | Feasibility |
|---|---|---|---|
| Request-derived filesystem path traversal | Request/argv/env value reaches `open`/`read`/`Path()`/`send_file` without a safe-join/allowlist check | `ubs-python.sh:5953`, `ubs-cpp.sh:1147`, `ubs-golang.sh:1239`, `ubs-java.sh:863`, `ubs-ruby.sh:710`, `ubs-elixir.sh:526`, `ubs-swift.sh:3433`, `ubs-js.sh:7299` | hook-feasible as same-file heuristic; true cross-file taint is cloud-tier (already Tier 1 in the existing plan doc) |
| Response header injection from request data | Unsanitized request value written into an HTTP response header (CRLF injection) | `ubs-python.sh:1979`, `ubs-js.sh:6988`, `ubs-golang.sh` C9, `ubs-java.sh` C4, csharp `run_response_header_injection_checks` (`modules/ubs-csharp.sh:2082`) | hook-feasible |
| Timing-unsafe secret/token comparison | `==`/`!=` on a variable named like a secret instead of a constant-time compare | `ubs-rust.sh:8377`, `ubs-golang.sh:6062`, `ubs-js.sh:8389`, `ubs-python.sh:4090` (we have the inverse gap — no check anywhere) | hook-feasible |
| CORS credentialed wildcard | `Access-Control-Allow-Origin: *` + `Access-Control-Allow-Credentials: true` in the same response chain | `ubs-golang.sh:6904`, `ubs-rust.sh:8549`, `ubs-js.sh:8124`, `ubs-python.sh:6383` | hook-feasible (single-file if both directives are set together; cross-file variant is harder) |
| CSRF protection disabled/skipped | Django/Rails/Phoenix CSRF middleware explicitly disabled | `ubs-python.sh:6846`, `ubs-elixir.sh:2473`, `ubs-ruby.sh:3340` (`protect_from_forgery` skip) | hook-feasible, needs a small per-framework regex table |
| Host header trusted for absolute URL construction | `request.headers['Host']` / `X-Forwarded-Host` concatenated into an absolute URL without an allowlist | `ubs-python.sh:5356`, `ubs-golang.sh:2240`, `ubs-js.sh:6159`, `ubs-rust.sh:8483` | hook-feasible |
| JWT verification bypass | `verify=False`, `algorithms=['none']`, `insecure_decode`, missing exp/claim validation on JWT decode | `ubs-python.sh:6213`, `ubs-golang.sh:6384`, `ubs-rust.sh:8388`, `ubs-js.sh:7892` | hook-feasible, FP-prone without context (UBS's own Tier-3 framing agrees) |
| Prototype pollution (generic, not just request-derived) | `Object.assign`/`_.merge`/`_.set` without `__proto__`/`constructor`/`prototype` key filtering | `ubs-js.sh:5374-5576` | hook-feasible (single-file) |
| NoSQL query injection | Unsanitized value interpolated into a Mongo/NoSQL query object/string | `ubs-python.sh:1179` | hook-feasible |
| LDAP filter/DN injection | Unsanitized value interpolated into an LDAP filter or DN string | `ubs-python.sh:2624` | hook-feasible |
| Server-side template injection (SSTI) | User input reaches a template-render call (Jinja2/ERB/EEx) unescaped | `ubs-python.sh:1721` | hook-feasible |
| Email header injection | Unsanitized value in an email `To`/`Subject`/`From` header (CRLF → header injection / spam relay) | `ubs-python.sh:2284` | hook-feasible |
| Debug mode + host allow-list left open | Framework `DEBUG=True`/`ALLOWED_HOSTS=['*']` in what looks like production config | `ubs-python.sh:7809` | hook-feasible |
| Insecure/weak filesystem permission modes | `os.chmod(path, 0o777)` or equivalent world-writable mode literal | `ubs-python.sh:4484` | hook-feasible |
| Unbounded request body / JSON decode without a size cap | No `MaxBytesReader`/body-size-limit before `json.Decode`/`ReadAll` | `ubs-golang.sh:5512`, `ubs-golang.sh:5305`, `ubs-rust.sh:8538`, `ubs-js.sh:9203` | hook-feasible |
| postMessage / message-event listener without origin check | `window.addEventListener('message', ...)` without checking `event.origin`; `postMessage(..., '*')` wildcard target | `ubs-js.sh:5903`, `ubs-js.sh:5825` | hook-feasible |
| Index arithmetic `arr[i±1]` without bounds check | Generic off-by-one risk from arithmetic directly inside a subscript, distinct from our tainted-input-only `index_bounds_unchecked` | `ubs-python.sh:10206`, `ubs-ruby.sh:2711`, `ubs-js.sh:3879` | hook-feasible — note: our `index_bounds_unchecked` (`agent-clarity.ts:383`) only fires when the index traces to parsed external input, not general `i-1`/`i+1` arithmetic, so this is a real gap not a naming mismatch |
| Type-narrowing invalidated by reassignment | `if (x !== null) {...}` then `x = ...` then `x.foo` again reads the stale guard as still valid | `type_narrowing_ts.js`, `type_narrowing_rust.py`, `type_narrowing_csharp.py`, `type_narrowing_swift.py` (all under `modules/helpers/`) | Explicitly already deferred in `docs/design/harness-ubs-cloud-checks-plan.md` Tier 4 — TS variant flagged hook-feasible there (reuses the `tsc` compiler API we already load), others cloud-tier |
| Bare/overly-broad except/rescue clauses | `except:` / `rescue` with no exception type — swallows everything including `KeyboardInterrupt`/`SystemExit` | `ubs-python.sh:10346`, `ubs-ruby.sh:2766`, `ubs-elixir.sh:2293` | hook-feasible — surprising gap given how central this is to UBS's Category 1/6 in every module |
| Ignored/swallowed Go errors (blank identifier, dropped `if err != nil { return nil }`) | `_ = someFn()` discarding an error return; `if err != nil { return nil }` swallowing the error instead of propagating it | `ubs-golang.sh:5236`, `ubs-golang.sh:5275`, `ubs-golang.sh:5291` (err shadowing via `:=`) | hook-feasible |
| Go `defer Close()`/`Rollback()` ordering relative to err-check (panic risk) | `defer resp.Body.Close()` placed after the `if err != nil` check panics on a nil response when err != nil | `ubs-golang.sh:5130`, `ubs-golang.sh:5159`, `ubs-golang.sh:5183`, `ubs-golang.sh:5190`, `ubs-golang.sh:7841`, `ubs-golang.sh:7863`, `ubs-golang.sh:7867` (7-row cluster, Go-specific) | hook-feasible (single-file AST ordering check) |
| `fmt.Errorf` without `%w` when wrapping an error | Error wrapped via string formatting loses `errors.Is`/`errors.As` unwrap chain | `ubs-golang.sh:5280` | hook-feasible |
| Exception thrown from a destructor | `~Foo() { throw ...; }` — terminates the program during stack unwinding | `ubs-cpp.sh:3025` | hook-feasible |
| `return`/`break`/`continue` inside `finally`/`ensure` | Silently swallows any exception in flight | `ubs-python.sh:10895`, `ubs-ruby.sh:3027` | hook-feasible |
| Global variable pollution / undeclared globals | Assignment to an undeclared/implicit global | `ubs-js.sh:10044`, `ubs-ruby.sh:3124`, `ubs-python.sh:10994` | hook-feasible |
| `debugger` statement / `pdb.set_trace()` / `binding.pry` left in code | Breakpoint left active in committed code | `ubs-js.sh:9921`, `ubs-python.sh:10936`, `ubs-ruby.sh:3067`, `ubs-elixir.sh:2636` | hook-feasible — trivial, surprising it's not already ported given `ubs_print_debug_leak` already exists for the sibling class |
| `alert`/`confirm`/`prompt` (blocking UI) | Synchronous blocking dialog left in production JS | `ubs-js.sh:9938` | hook-feasible |
| `var` instead of `let`/`const` | Legacy function-scoped declaration | `ubs-js.sh:10026` | hook-feasible (trivial regex) |
| Go closure captures loop variable (pre-1.22 capture bug) | `for i := range xs { go func(){ use(i) }() }` captures the shared loop var, not a per-iteration copy | `ubs-golang.sh:4960`, `ubs-golang.sh:4956` | hook-feasible |
| Async lock/mutex guard held across an `await`/yield point | Holding a `tokio::Mutex`/`SemaphoreSlim`/`std::sync` guard across an await risks deadlock (the guard blocks the executor thread) | `ubs-rust.sh:9110`, `ubs-rust.sh:9103`, csharp `SemaphoreSlim.Wait()` (`modules/ubs-csharp.sh:3440`) | hook-feasible — note this is distinct from our existing `await_state_toctou` (different bug shape: TOCTOU on re-checked state, not a held lock guard) |
| Java `ExecutorService` created without a shutdown path | Thread pool leak — no `shutdown()`/`shutdownNow()` reachable | `ubs-java.sh:3928`, `ubs-java.sh:3499` (unbounded `newCachedThreadPool`) | hook-feasible |
| C# multiple-enumeration / `First()`/`Single()` without existence check | `.Count() > 0` then re-enumerate; `.First()` without `.Any()` risking `InvalidOperationException` | csharp (`modules/ubs-csharp.sh:1344`, `:1353`) | hook-feasible |
| Rust panic surfaces: `nth(0)` vs `next()`, direct indexing/slicing, `get_unchecked` | Indexing/slicing panics on out-of-range instead of returning `Option`/`Result` | `ubs-rust.sh:8289`, `ubs-rust.sh:9146`, `ubs-rust.sh:8114` | hook-feasible |
| C++ manual `Lock`/`Unlock`, Go manual `Mutex.Lock`/`Unlock` (non-Rust) without RAII/defer | Exception/early-return path skips the unlock | `ubs-cpp.sh:3059`, `ubs-golang.sh:4977`, `ubs-java.sh:3491` (`synchronized(this)` is the Java analog but a different shape) | hook-feasible; our `ubs_mutex_lock_unwrap` covers only the Rust `.lock().unwrap()` shape |
| Predictable/insecure temp file paths (non-Python) | `/tmp/<predictable-name>` race outside Python's `tempfile.mktemp` | `ubs-rust.sh:8463`, `ubs-ruby.sh:2927` (`Tempfile`/`Dir.mktmpdir` without a block) | hook-feasible; our `ubs_tempfile_mktemp_race` is Python-only |
| Large inline arrays/objects / large embedded outputs (memory waste) | Big literal array/object/notebook-output embedded in source | `ubs-js.sh:9995`, `ubs-python.sh:11321` | hook-feasible |
| Rust `clone()`/`format!`/allocation calls inside loops | Unnecessary per-iteration heap allocation | `ubs-rust.sh:8259`, `ubs-rust.sh:9338` | hook-feasible |
| Whole-project resource-lifecycle correlation (acquire in file A, release in file B, or never) | Cross-file join of acquire/release call sites via the import graph | `modules/helpers/resource_lifecycle_{py,go,java,csharp}.{py,go}` | **cloud-tier** — already Tier 2 in the existing plan doc; our `resource_handle_leak` (`checks/error-context.ts:438`) is single-file only, confirmed by reading it |
| Ruby/Elixir/C# language-specific classes not otherwise listed (Rails strong-params bypass, Ecto N+1/raw-fragment, GenServer crash-on-bad-return, Phoenix auth-plug-missing, C# `IDisposable`/`HttpClient` reuse, C# `async void`) | See §3 — entire language surfaces | `ubs-ruby.sh`, `ubs-elixir.sh`, `modules/ubs-csharp.sh` throughout | hook-feasible per-item; the blocker is zero language-profile/extension wiring, not detector difficulty |

**Tally: 39 named MISSING classes above** (the Ruby/Elixir/C# row bundles an
estimated 15–20 further classes that are language-surface-blocked rather than
individually novel — see §3). Roughly **35 of the ~39 rows are hook-feasible**;
only whole-project resource-lifecycle correlation and the non-TS type-narrowing
variants are genuinely cloud-tier, consistent with the existing plan doc's
~25-cloud-tier estimate — this analysis did not surface a materially different
cloud-tier count than what's already documented.

## 5. PARTIAL coverage (class exists, language/scope gap)

| Our check id | What it covers now | What's missing |
|---|---|---|
| `ubs_archive_extract_traversal` (`checks/archive-extract.ts:34`) | Python `.extractall()`, Node `tar.x`/`tar.extract`/adm-zip | Go, Java, Ruby, Elixir, Swift, C++, C# — UBS runs this check in all 7 |
| `ubs_unchecked_redirect` (`checks/ubs-language-specific/js-security-checks-dom-crypto.ts:23`) | JS/TS only | Java, C++, Go, Ruby, Swift, Elixir, Rust, Python all have their own "request-derived open redirect" check in UBS |
| `endpoint_ssrf_shape` (`checks/endpoint-security.ts:325`) | Endpoint-handler-shaped SSRF (JS/TS route heuristics) | Python `requests.*`/`urllib`, Go `http.Get`, Rust `reqwest` general (non-endpoint-shaped) outbound-URL taint |
| `ubs_sql_string_concat` (`checks/ubs-language-specific/cross-language-checks.ts:23`) | `.ts .tsx .js .jsx .mjs .cjs .py .go .rs .swift` | Java (`Statement.executeQuery` concat), C/C++, Ruby, Elixir (raw Ecto fragment interpolation), C# |
| `ubs_division_by_variable` (`checks/ubs-language-specific/division-by-variable.ts`) | JS/TS, Python | C++, Ruby, Rust — UBS runs this in all 5 of these languages, we cover 2 |
| Pickle/marshal/shelve/YAML/torch unsafe-load family (`ubs_pickle_untrusted_load`, `ubs_pickle_wrapper_load`, `ubs_marshal_load`, `ubs_shelve_open`, `ubs_torch_unsafe_load`, `ubs_yaml_unsafe_load`) | Python only — and broader than UBS's Python module (we also catch marshal/shelve/joblib/torch, which UBS doesn't) | Java deserialization (`ubs-java.sh:3534`), Ruby `Marshal`/YAML unsafe loads (`ubs-ruby.sh:2814`), Elixir `:erlang.binary_to_term` w/o `:safe` (`ubs-elixir.sh:2451`), Swift `NSKeyedUnarchiver` insecure unarchiving (`ubs-swift.sh:3247`) |
| `eval_usage` / `ubs_eval_input_tainted` | JS `eval()`/`new Function()`, Python eval/exec on tainted input | Ruby `eval`/`instance_eval`/`class_eval` (`ubs-ruby.sh:2806`), Elixir `Code.eval_string` (`ubs-elixir.sh:2385`) |
| `non_null_assertion` | TypeScript `!` only | Swift force-unwrap (`ubs-swift.sh:3079`), implicitly-unwrapped optionals (`ubs-swift.sh:3098`), `IBOutlet` IUO (`ubs-swift.sh:4180`) have no dedicated check — several `swift_*` checks touch adjacent shapes but not bare force-unwrap counting |
| `law_of_demeter` (`entries-taste.ts:161`) | Property chains >4 segments, design-smell framing | UBS's "Attribute chains depth" (`ubs-python.sh:10038`) is NPE-safety framed (chain length threshold 15, suppressed when guarded by a conditional) — same code shape, different intent/threshold; not a clean 1:1 |
| `sync_io_on_hot_path` (`entries-warnings/agent-laziness.ts:198`) | `*Sync` calls specifically inside HTTP-handler-shaped JS/TS functions | UBS's broader "Blocking calls in async def" (Python, `ubs-python.sh:10327`) and "Blocking ops inside async" (Rust, `ubs-rust.sh:8177`) — any blocking call inside any async function, not just handler-shaped ones |
| `discriminated_union_exhaustiveness` / `implicit_switch_fallthrough` | TS discriminated-union exhaustiveness; Java/JS classic fallthrough | UBS's plain "switch without default" (`ubs-js.sh:9861`, `ubs-java.sh:3701`) on non-union switches isn't targeted by either |
| `index_bounds_unchecked` (`entries-warnings/agent-clarity.ts:383`) | Only fires when the index provably traces to parsed external input (`req.body`/`query`/`argv`/`env`) | UBS's version (`ubs-python.sh:10206`, `ubs-ruby.sh:2711`, `ubs-js.sh:3879`) is unconditional — any `arr[i±1]` arithmetic, tainted or not — listed here and in §4 because the overlap is real but narrow |
| C/C++ tool wrapping (`c_compile`, `clang_tidy`) | Compile + clang-tidy | UBS also runs sanitizers-configured / warnings-enabled / CMake-hygiene checks (`ubs-cpp.sh` Cat 12–13) as source inspection, not just compiler invocation |
| Go/Rust/Python dependency-audit tooling (`dependency_audit`) | Generic manifest/lockfile vulnerability check | Not equivalent to `govulncheck`, `cargo audit`, `pip-audit`/`safety` run per-tool — one generic pass may miss ecosystem-specific advisories those tools carry |

## 6. What "100% parity" would concretely require

Parity is **not** "implement 39 more detectors." Three separate efforts, in
priority order by leverage:

1. **Wire Ruby, Elixir, and C# into `language-profiles-data.ts`** (extension
   map + toolchain profile) and give each at least the already-generic
   cross-language checks (`ubs_sql_string_concat`, `ubs_division_by_variable`,
   `ubs_archive_extract_traversal` etc.) by extending their extension
   allow-lists — several of those files already have a comment marking this
   as "a one-line edit," never taken. This alone closes the language-breadth
   gap for every bug class that's already implemented for ≥1 language, which
   by our clustering is roughly half of the ~108 distinct classes. Highest
   leverage, lowest novelty — no new detection logic, just gate-widening.
2. **Implement the 39 named MISSING classes in §4**, ~35 of which are
   single-file hook-feasible today. This is genuinely new detector logic but
   each is small (regex/single-function AST shape), consistent with how the
   253 inline checks that already exist were built.
3. **Cloud-tier work** (whole-project resource-lifecycle correlation, non-TS
   type-narrowing, cross-file taint for the request-derived-* family) is
   already scoped in `docs/design/harness-ubs-cloud-checks-plan.md` Tiers 1–4
   and unchanged by this analysis — that doc's phasing still holds. This
   analysis did not find a bigger cloud-tier backlog than what's already
   written down (~25 items), just confirmed which items land there
   (resource-lifecycle correlation, non-TS type-narrowing) vs. which were
   mis-filed as cloud-only when they're actually hook-feasible as a
   same-file approximation (path traversal, SSRF, open redirect — UBS itself
   implements all of these as single-file regex/AST heuristics, not
   cross-file taint, so a same-file version is both faithful to upstream and
   within hook budget; only the *fully precise* cross-file version needs the
   cloud tier).

**Honest read of the gap**: the "~130 novel candidates" framing in the older
plan doc was in the right order of magnitude for distinct classes (measured
here at ≈108, in the same ballpark once you account for the doc's number
being pre-dedup-cleanup and against a different UBS version), but the state
of *landing* is far behind "incrementally shipped" — of ≈108 distinct classes,
we cover something in the neighborhood of half (≈36 cleanly, ≈22 partially),
and the single biggest lever isn't writing new detectors, it's that three
entire languages were never wired up at all. That's a config/wiring gap, not
a hard research problem, and it's the fastest path to moving the needle.
