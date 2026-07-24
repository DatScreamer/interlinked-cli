# Bun-regression detectors — five checks from four real bugs

**Status:** Plan, 2026-07-09. Not built (D1 partially landed uncommitted by a parallel
session — see §2). Sourced from `docs/external-pulse/bun-in-rust.md`.

**The premise.** Bun shipped 19 known regressions in the Rust port. Four are described in
the post with enough precision to reconstruct. **All four pass the harness as committed at
HEAD** (226 inline checks, 344 total). These are not speculative taste checks; they are the
checks that would have caught bugs a very good team shipped anyway, after adversarial
review, on a suite with 1.38M assertions.

> Most of the regressions came from code that's syntactically identical in both languages
> but semantically different.

That sentence is the detector spec. Each check below finds a construct whose *meaning*
depends on a compilation mode, an optimization flag, or an evaluation order that the
surrounding syntax does not reveal.

---

## 1. The five

**Single source of truth for id / phase / gate.** This table supersedes the earlier draft of
this document, which proposed a single multi-language `assert_side_effect` id. It was wrong —
see §2.3.

| # | Check id | Bun bug | Phase | Gate | Determinism |
|---|---|---|---|---|---|
| D1a | `ubs_rust_debug_assert_side_effect` *(exists, uncommitted)* | side effect inside `debug_assert!` | `post` | advisory | heuristic |
| D1b | `ubs_c_assert_side_effect` | same class, `NDEBUG` | `post` | advisory | heuristic |
| D1c | `ubs_python_assert_side_effect` | same class, `python -O` | `post` | advisory | heuristic |
| D1d | `ubs_java_assert_side_effect` | same class, assertions **off by default** | `post` | advisory → default first | heuristic |
| D2a | `ubs_rust_unchecked_cast_slice` | `bytemuck::cast_slice` panics on odd length | `post` | advisory | heuristic |
| D2b | `unaligned_reinterpret` (JS/TS typed arrays) | same class | `post` | advisory | heuristic |
| D3 | `placeholder_runtime_constant` | `BSS_OVERFLOW_BLOCK_SIZE = 64` stand-in | `post` | advisory → default | heuristic |
| D4 | `regex_from_interpolation` | `comptime` format string rewrote markers over args | `post` | default | partially_deterministic |
| D5 | `rust_unsafe_span` | "78% of unsafe blocks are a single line" | `post` | advisory | fully_deterministic |

**Every heuristic check is `post`.** `check-registry/types.ts` reserves `pre_warn` for
"fully-deterministic or low-FP partial-deterministic checks" and makes `post` the "default for
heuristic warnings where pre-block would train the model to distrust all rails." The first
D1a draft used `phase: "pre_warn"` with `determinism: "heuristic"` — that violated the
contract and has been corrected in the working tree (§2.4). Its sibling heuristic
`ubs_division_by_variable` is correctly `post`.

### What "advisory" actually means — and does not

Three unrelated things in this codebase are called "advisory." Confusing them is how a
detector ends up warning on every edit while its author believes it is quiet.

| Surface | Mechanism | Effect |
|---|---|---|
| `interlinked verify` default output | `DEFAULT_ADVISORY_SKIPS` (`commands/verify/advisory.ts`) | check is skipped unless `--all-checks` |
| Escalation amplification | `ADVISORY_CHECK_IDS` (`behavioral-checks.ts:281`) | finding never escalates |
| **Cold-file recency gate** | `shouldRunAdvisoryChecks(filePath, priority)` (`file-priority.ts:109`) | unrelated: returns `tier !== "cold"`; drops *all* heuristics on files unchanged 180+ days |

**None of them silences the check for the agent.** `write-content-guards.ts:454` runs every
`pre_warn` check on Write/Edit, and `quality-checks/inline-block.ts:282` runs every `post`
check on PostToolUse — neither consults either advisory set. Verified by calling
`buildAgentSafetyChecks` directly (`scratch/probe-post-advisory.mts`):
`isAdvisoryCheckId("ubs_rust_debug_assert_side_effect") === true`, and it still fires at
`post`.

So `pre_warn` → `post` moves the warning from *before* the bytes land to *after*, and takes it
off the write-decision path. It does **not** make it invisible. The only things that keep a
heuristic quiet for the agent are: a low false-positive rate, `content_keywords`, or the
cold-file gate. Plan accordingly — "ship it advisory-first" is a statement about `verify` and
escalation, not about agent-visible noise.

Plus one non-detector fix (§8): **`interlinked-ignore` is not counted by
`suppression_ratchet`** — the harness's own suppression directive bypasses the harness's own
suppression ratchet.

---

## 2. D1 — the assert-erasure family

### 2.1 Status: half-built; first-draft false-positive bug fixed in tree

A parallel session landed `checkRustDebugAssertSideEffects` /
`ubs_rust_debug_assert_side_effect` (`checks/ubs-language-specific/rust-go-checks.ts`,
`.rs`-only, advisory) today, uncommitted. Its structure is right — brace-balance the macro
argument, look for `?`, assignment ops, or a mutating call. Its first verb regex was wrong:

```
/\b(?:insert|push|pop|remove|delete|set|write|send|close|open|spawn|create|update|
   clear|append|extend|retain|sort|reserve|truncate|drain|take|swap|store|alloc|
   free|unpin|pin|register|unregister|detach|resize|reset|start|stop|commit|
   rollback|flush|emit|notify|mark|invalidate)[A-Za-z0-9_]*\s*\(/
```

The trailing `[A-Za-z0-9_]*` turns every verb into a prefix match:

| Idiom | Matches | Verdict |
|---|---|---|
| `debug_assert!(s.starts_with("x"))` | `start` + `s_with` | **false positive** — and `starts_with` in an assert is a very common Rust idiom |
| `debug_assert!(cfg.settings().len() > 0)` | `set` + `tings` | **false positive** |
| `debug_assert!(v.taken().is_none())` | `take` + `n` | **false positive** |
| `debug_assert!(w.writer().is_ok())` | `write` + `r` | **false positive** |
| `debug_assert!(x.opened())` | `open` + `ed` | **false positive** |

Also firing: `conn.closed()` (`close`+`d`), `e.created_at()` (`create`+`d_at`),
`q.popped()` (`pop`+`ped`).

**Fix — one character class.** Do *not* anchor by requiring a receiver dot; that was this
doc's first proposal and it regresses on `self.set_len(n)` and `mem::swap(a, b)`. Instead
allow only a **snake_case continuation** of the verb:

```diff
-  ...|mark|invalidate)[A-Za-z0-9_]*\s*(?:::<[^>]*>\s*)?\(/
+  ...|mark|invalidate)(?:_[a-z0-9_]+)?\s*(?:::<[^>]*>\s*)?\(/
```

`set` + `_len` matches; `set` + `tings` does not. `start` + `s_with` does not. Measured over a
25-case corpus (13 mutators, 12 pure predicates): shipped regex **8 mismatches**, fixed regex
**0**. Preserved true positives include `set_len`, `push_str`, `remove_entry`, `mem::swap`,
`ptr::write`, `take_while`, and the bare free call `insert(k)`. Reproduction:
`scratch/probe-debug-assert-regex.mjs`.

The `?` try-operator and assignment-operator heuristics (`hasRustTryOperator`,
`hasRustAssignment`) are sound as written — I verified `==`, `!=`, `>=`, `<=`, and `=>` are all
correctly excluded. Keep them.

**Negative tests:** keep coverage for `starts_with`, `settings`, `taken`, `writer`, `closed`,
`opened`, `created_at`, `popped`, plus a stripping case where only the live assertion is
reported and comment/string occurrences are ignored.

This is the check's own dogfood loop (`feedback_dogfood_harness_from_errors`): the fix to the
detector matters more than the fix to any one call site.

### 2.2 Generalize: which languages actually erase assertions

The bug class is *"the assertion's argument does not run in the shipping build."* It exists
wherever assertions are compiled out. It does **not** exist in JS.

| Language | Construct | Erased when | Ship in v1? |
|---|---|---|---|
| Rust | `debug_assert!` / `_eq` / `_ne` | optimized (release) builds | yes — exists |
| C / C++ | `assert(...)` | `NDEBUG` defined | yes |
| Python | `assert <expr>` | `-O` / `PYTHONOPTIMIZE` | yes |
| **Java** | `assert <expr>;` | **by default** — assertions are OFF unless `-ea` | yes — the sharpest case |
| JS/TS | `console.assert(...)` | args always evaluate; only terser `drop_console: true` removes the call | **no** — needs bundler-config knowledge; FP-prone |
| Go | — | no assert construct | n/a |

Java is the most valuable addition and the least obvious: `assert list.add(x);` silently
does nothing in production, because the JVM disables assertions by default. Python's `-O` is
the second: `assert cache.pop(k) is not None` is a no-op under `python -O`.

### 2.3 Do NOT rename to a single multi-language id

An earlier draft of this doc proposed collapsing everything into one `assert_side_effect`
check. That was wrong, on two grounds:

1. **Convention.** The `ubs_*` family is per-language throughout: `ubs_js_loose_equality`,
   `ubs_java_optional_get`, `ubs_python_mutable_default_arg`, `ubs_goroutine_no_waitgroup`,
   `ubs_rust_debug_assert_side_effect`.
2. **Promotion granularity — the load-bearing reason.** Advisory membership is *per check id*
   (`ADVISORY_CHECK_IDS` / `DEFAULT_ADVISORY_SKIPS` are id sets). One id forces one gate
   decision across five languages whose FP profiles are nothing alike. Java's `assert` is
   **disabled by default** — no `-ea` flag needed to break it — so `assert list.add(x)` is
   unconditionally a bug and can reach the default gate early. Rust's detector is a *method-name
   heuristic* and must stay advisory until a real-repo audit. Collapsing them means Java waits
   on Rust, or Rust ships loud. Keep them separate.

So: **keep `ubs_rust_debug_assert_side_effect`.** Add `ubs_c_assert_side_effect`,
`ubs_python_assert_side_effect`, `ubs_java_assert_side_effect` as siblings sharing one helper
(`src/harness/checks/assert-side-effects.ts`), each with its own registry entry, metadata,
`content_keywords`, and gate.

### 2.4 The first entry was on the wrong surface

The first `ubs_rust_debug_assert_side_effect` registry entry used `phase: "pre_warn"`
(`entries-warnings/ubs-checks.ts:91`) with `determinism: "heuristic"`. Its `advisory.ts`
rationale said to keep it advisory precisely because the heuristic is a proxy. **Advisory
placement would not have achieved that.** Verified:

- `ADVISORY_CHECK_IDS` is consumed in exactly one place — `behavioral-checks.ts:281`
  (escalation-amplification suppression).
- `DEFAULT_ADVISORY_SKIPS` is consumed only by `interlinked verify`.
- `write-content-guards.ts:454` calls `buildAgentSafetyChecks(content, filePath, "pre_warn", …)`
  on **every** Write/Edit and consults neither set.

So a `pre_warn` + advisory check still warns the agent on every Rust edit. With the first
verb regex that was a ~1-in-3 false-positive rate (§2.1). Keep the registry phase at `post`
and keep the id in both advisory sets.

**Gate:** advisory until a real-Rust FP audit passes (§7). Do not promote on the strength of
this repo's dogfood — this repo contains no `.rs` files.

### Cases

Positive: Rust `debug_assert!(map.insert(k, v).is_none())`; Rust `debug_assert!(f()?)`;
C `assert(fclose(fp) == 0);`; Python `assert queue.pop() is not None`;
Java `assert results.add(row);`.

Negative: `debug_assert!(s.starts_with("x"))`; `debug_assert_eq!(v.len(), 3)`;
`assert(ptr != NULL);`; `assert isinstance(x, Foo)`; `assert x.is_valid()` where
`is_valid` is not in the verb set; any assert in a test file (`isTestFile` guard, already
present).

---

## 3. D2 — `ubs_rust_unchecked_cast_slice` / `unaligned_reinterpret`

Bun's bug: `reinterpretSlice(u16, bytes)` used `@divTrunc` and ignored a trailing odd byte;
`bytemuck::cast_slice` **panics** on it instead. `Blob.text()` on a UTF-16 BOM followed by an
odd number of bytes crashed the process. The fix was `&buf[..buf.len() & !1]`.

The class: **reinterpreting a byte buffer as a wider element type without proving the length
(or offset) is a multiple of the element size.**

### Detection (JS/TS v1)

Fire on `new <T>Array(<expr>)` where `T` has element size ≥ 2 (`Uint16`, `Int16`, `Uint32`,
`Int32`, `Float32`, `Float64`, `BigInt64`, `BigUint64`) or `new DataView(<expr>)`, **and**
`<expr>` is a strong buffer signal — it ends in `.buffer`, or is an identifier matching
`/^(buf|buffer|bytes|raw|data|chunk)$/i`, or is a call to `.slice(`/`.subarray(`/
`readFileSync(` — **and** no alignment guard appears in the preceding 40 lines:

```
/\.byteLength\s*%\s*\d+|\.length\s*%\s*\d+|&\s*~\s*\d+|Math\.floor\([^)]*\/\s*\d+\)/
```

The `.buffer` suffix is the load-bearing signal. `new Uint16Array(10)` (numeric literal →
allocates, always safe) and `new Uint16Array([1,2,3])` (array → copies, safe) must not fire;
requiring the buffer signal excludes both without needing type inference.

**Gate: advisory.** This is a heuristic and it cannot distinguish `ArrayBuffer` from
`number[]` statically. Advisory is the honest placement; do not promote without type info.

### Rust (v2, deferred)

`bytemuck::cast_slice`, `bytemuck::from_bytes`, `slice::align_to`, `from_raw_parts` on a
`&[u8]` without a `len() % N == 0` guard. Deferred: needs the same guard-scan machinery and
Rust has no dogfood corpus here yet.

### Cases

Positive: `new Uint16Array(buf.buffer)`; `new DataView(bytes.buffer)` followed by
`.getUint16(i)`; `new Float64Array(readFileSync(p).buffer)`.

Negative: `new Uint16Array(16)`; `new Uint8Array(buf.buffer)` (element size 1 — always
aligned); `new Uint16Array(buf.buffer.slice(0, buf.byteLength & ~1))` (guard present);
`new Uint16Array([1, 2, 3])`.

---

## 4. D3 — `placeholder_runtime_constant`

Bun's bug, verbatim from the post:

```rust
/// ... so use a nonzero stand-in until Phase B threads the
/// per-instantiation value through.
pub const BSS_OVERFLOW_BLOCK_SIZE: usize = 64;
```

That lowered an interning ceiling from 8.4M to 270,272, which real projects hit, and made a
`ptrs[4095]` off-by-one reachable. **The comment confessed. Nothing read it.**

### Detection

A **numeric** constant declaration whose own line, or one of the ≤3 lines immediately above
it, carries a comment matching:

```
/\b(?:stand[-\s]?in|provisional|interim|temporar(?:y|ily)|for\s+now|
    until\s+(?:we|the|phase\s|[A-Z])|to\s+be\s+(?:replaced|threaded|wired|computed)|
    hardcod(?:ed?|ing)|nonzero\s+(?:stub|value|stand))\b/i
```

Declaration forms: TS/JS `const NAME = <num>`, Rust `const NAME: T = <num>` /
`static NAME: T = <num>`, Python module-scope `NAME = <num>`, Go `const NAME = <num>`.

**Numeric-only in v1.** A string constant with a "placeholder" comment is usually UI copy
(`const PLACEHOLDER_TEXT = "Enter your name"`), which is the FP that sank the original
`agent_thumbprint_prose` heuristic. Numeric literals with a confession comment are almost
always real.

Exempt: test files (`isTestFile`), `@codegen-data` files, `isVendoredOrFixturePath`.

### Relationship to existing checks

- **`agent_thumbprint_prose`** (`checks/agent-laziness.ts`) scans comment *prose* and
  deliberately does not fire on bare "placeholder." Its phrase list has **no**
  `stand-in` / `provisional` / `interim` / `until Phase` pattern. D3 is its inverse: it
  requires the confession comment **and** a value binding, which is what makes it low-FP.
  Together they close `harness-anti-workaround.md` class 6.
- **`duplicated_policy_constant`** (`checks/policy-constant-drift.ts`) needs a policy-shaped
  name (`DEFAULT_*` / `*_CAP` / `*_THRESHOLD`) **and** a duplicated literal. `BSS_OVERFLOW_BLOCK_SIZE`
  is neither. No overlap.
- **`checkMagicNumbers`** (`checks/taste-smell.ts`) targets *un-named* literals. A named
  `const` is the opposite shape. No overlap.

**Gate:** advisory first (one week), then promote to default. The confession-comment
requirement makes this the highest-precision check in the set.

### Cases

Positive: the Bun constant verbatim; `const MAX_RETRIES = 3; // hardcoded for now`;
`const BATCH = 64  # interim until we profile`.

Negative: `const PLACEHOLDER_TEXT = "Enter name"` (string); `const MAX_RETRIES = 3;` (no
comment); `// TODO: document this\nconst MAX_RETRIES = 3;` (the comment confesses about the
*docs*, not the value — requires the phrase list to exclude bare `TODO`; **note this and
keep `TODO`/`FIXME` out of the pattern**); any constant in a test file.

---

## 5. D4 — `regex_from_interpolation`

Bun's bug: `Output.pretty` rewrites `<r>` / `<d>` markers into ANSI escapes. In Zig `fmt` is
`comptime`, so markers are gone before arguments are substituted. In Rust the function only
ever saw the finished string, and **rewrote markers inside the arguments too** — a hyperlink's
trailing `ESC \` ate the `<` of the next marker.

The general class is **interpolate-then-parse**: a string is built by interpolation and then
handed to a function that parses or rewrites markup in it, so data becomes syntax. This is
the same shape as SQL injection, shell injection, and log injection.

### What we already have, and what we don't

Enumerated sinks, each a hardcoded regex: `ubs_sql_string_concat`,
`sql_escape_hatch_non_literal`, `child_process_exec_user_input`, `ubs_eval_input_tainted`,
`logger_format_user_input`, `tainted_to_privileged_sink` (advisory). There is **no generic
"template literal reaches a parsing function"** check — and specifically **no
`new RegExp(\`${x}\`)` detector anywhere.**

### v1: ship the deterministic member, name the general class

`regex_from_interpolation` — `new RegExp(...)` or bare `RegExp(...)` whose first argument is
a template literal containing `${`, or a `+` concatenation with a non-literal operand, and
no escaping in scope:

```
/escapeRegExp|escapeStringRegexp|escape_regex|\.replace\(\s*\/\[\.\*\+\?\^\$\{\}\(\)\|\[\\\]\\\\\]\/g/
```

Deterministic, near-zero FP, and it dogfoods cleanly: this repo interpolates variable names
into regexes in `checks/nan-coercion.ts` and always routes through its local
`escapeForRegex` (`nan-coercion.ts:98`) — so our own source passes. A check that fires on
our own correct code is a check that will be turned off.

**Gate:** `post`, default, severity warning.

### v2: the general form needs a declared-parser registry

The full class needs to know *which functions in this repo parse their input*. We already
have the substrate: `discovered-primitives.ts` learns project-local wrappers of builtins and
ratchets on their bypass (`discovered_primitive_ratchet`). Extend it with a
`parses_its_input` classification, seeded from a small builtin list (`RegExp`,
`new Function`, `vm.runInNewContext`) and grown by declaration. Then D4-general fires on any
template literal with substitutions reaching a declared parser. **Not v1** — it needs a
config surface and a migration story.

### Cases

Positive: ``new RegExp(`^${prefix}`)``; ``RegExp("^" + userInput)``;
``new RegExp(`${a}|${b}`, "g")``.

Negative: ``new RegExp(`^${escapeRegExp(prefix)}`)``; `new RegExp("^[a-z]+$")` (literal);
`new RegExp(SOME_CONST)` (identifier, not interpolation); a regex built from a template with
no `${`.

---

## 6. D5 — `rust_unsafe_span`

> about 4% of Bun's Rust code sits inside an `unsafe` block (~13,000 `unsafe` keywords across
> ~27,000 lines / ~780,000 lines), and **78% of those blocks are a single line**

Two orthogonal properties: escape-hatch **density** (ratcheted) and escape-hatch **scope**
(unmeasured). We ratchet density for `as any`, `@ts-ignore`, `: any`, non-null `!` — via the
in-session `PreEditBaseline` counters in `quality-checks/ratchet-metrics.ts`. We measure
scope **nowhere**. `rust_unsafe_blocks` (`language-profiles-data.ts:193`) detects a block's
*existence* and exempts it if a `// SAFETY:` comment precedes it. Nothing asks how big it is.

The only scope-aware check today is `checkFileLevelSuppression`
(`checks/agent-laziness.ts:359`), a binary file-vs-line distinction.

### Detection

- **Rust:** `unsafe {` … matching `}` spanning more than `MAX_UNSAFE_SPAN_LINES` (default 3).
  Brace-balance with `stripForBraceScan`. Fully deterministic.
- **JS/TS:** block-form `/* eslint-disable */` … `/* eslint-enable */` regions spanning more
  than N lines. (`@ts-ignore`, `@ts-expect-error`, `biome-ignore` are line-scoped by
  construction; `@ts-nocheck` is already `file_level_suppression`.)

Message: *"this `unsafe` block spans 41 lines. Narrow it to the operations that actually
require it — 78% of Bun's post-port unsafe blocks are one line."*

**Gate:** advisory. This is a taste lever with a real risk of `harness-anti-workaround.md`
class 5 (mechanical busywork). Do not block on it.

**Deliberate non-goal:** do **not** ratchet Rust `unsafe`/`unwrap()`/`panic!` counts in v1.
The counted-token ratchet in `ratchet-metrics.ts` is nine hand-written quads (regex +
counter + `PreEditBaseline` field + `if` block + capture line across three files). Adding
Rust tokens means five more edits each. The right move is to make the ratchet **data-driven**
first — a `RATCHET_TOKENS: Array<{id, pattern, exts}>` table — and that is its own PR.

---

## 7. Test discipline

Each check ships **≥3 positive and ≥3 negative** cases (house rule, CLAUDE.md). Beyond that:

**The Bun corpus as a permanent fixture.** Encode the four regressions as minimal fixture
files under `src/harness/checks/__fixtures__/bun-regressions/`, one per bug, in the original
language. Assert each detector fires on its own fixture and on none of the others. This is a
real-bug FP/FN corpus — worth more than any synthetic case, and it is the artifact that keeps
these five checks honest as they are refined.

**Dogfood D1 against real Rust.** This repo has no `.rs` files, so `assert_side_effect`'s
Rust path gets zero dogfood signal locally. Use `skills/cross-repo-validate` (already built:
"run the harness static checks against N real foreign repos; report per-detector fire rate +
sampled precision") against 3–5 Rust repos before promoting D1 to default. The anchored-verb
fix in §2 is a hypothesis until that runs.

---

## 8. The suppression hole (not a detector)

`suppression_ratchet` (`quality-checks/ratchet-metrics.ts:12`) counts `@ts-ignore`,
`@ts-expect-error`, `eslint-disable`, `biome-ignore`. It does **not** count
`// interlinked-ignore: <check>` — the harness's own fully-suppressing directive
(`suppressions.ts:42`, "the finding never surfaces, even above threshold").

So an agent can silence unlimited interlinked findings without tripping any ratchet. It *is*
logged (`recurrence.ts:30`, `agent_suppressed` outcome signal), but logging is not gating.

**Fix:** add `interlinked-ignore` to `SUPPRESSION_PATTERN`'s alternation. One line. Ship it
with this PR — it is the cheapest closure of a self-gaming hole in the whole program, and it
is squarely `feedback_local_checks_not_a_trust_boundary` territory: the local gate is not a
trust boundary, but it should at least not hand out a silent bypass.

(Deliberately **not** gating `// interlinked: defer` — it is designed to be loud and
auditable, and an empty-reason defer is already treated as audit signal.)

## 9. Wiring — every file, in order

Per-check, the contract (verified against source, 2026-07-09):

1. Detector in `src/harness/checks/<family>.ts`, signature
   `(content: string, filePath: string) => InlineMatch[]`. Extension-gate **inside the
   detector body** (`getExtension` + `JS_TS_ALL_EXTS`, or `!== ".rs"`); there is no
   extension field on the registry entry. Strip with `stripCommentsAndStrings` first. Cap
   matches (`MAX_MATCHES_PER_FILE = 10`, or the UBS family's `MATCH_LIMIT`).
2. `src/harness/checks/<family>.test.ts` — ≥3 pos / ≥3 neg.
3. `CheckRegistration` in `check-registry/entries-warnings/<group>.ts`
   (`entries-errors.ts` only for `pre_block`, which requires `determinism:
   "fully_deterministic"` and zero FP — **none of D1–D5 qualifies**). Set
   `content_keywords` as a substring pre-filter (e.g. D4 → `["RegExp"]`).
4. `CheckMeta` in `check-metadata/generic-<fragment>.ts`.
5. `check-metadata/generic-fragments.test.ts` — add the id to the fragment `keys` list
   **and** bump the hardcoded `205` total (it appears **twice**).
6. `check-inventory.test.ts` — bump `EXPECTED_BY_FAMILY.inline` and `EXPECTED_TOTAL`.
7. Verify wiring: a `toIssues(...)` push in `commands/verify/file-checks-agent-safety.ts`
   (or `file-checks-ubs.ts` for the UBS family) + the `CodeQualityResults` prop.
8. If advisory: add the id to **both** `harness/advisory-check-ids.ts` (`ADVISORY_CHECK_IDS`)
   and `commands/verify/advisory.ts` (`DEFAULT_ADVISORY_SKIPS`, **with a rationale comment**).
   They are pinned set-equal by `advisory-check-ids.test.ts`; `DEFAULT_ADVISORY_SKIPS` is
   *additionally* pinned as a sorted literal by `commands/__tests__/verify.test.ts:190`.
9. `check-pipeline-parity.test.ts` — add the camelCase prop to `AGGREGATED_IN_JSON` unless it
   is individually destructured in `outputJson`.

### Count math

At HEAD: `inline: 226`, `EXPECTED_TOTAL: 344`. There is **no rename** (§2.3). D1a already
exists in the working tree; D1b, D1c, D1d, D2a, D2b, D3, D4, D5 are **eight new ids**.

- Against HEAD: inline 226 → 235, total 344 → 353 (nine ids, counting D1a).
- Against the current working tree (which already carries D1a): 227 → 235, 345 → 353.

Bump `EXPECTED_BY_FAMILY.inline` and `EXPECTED_TOTAL` in `check-inventory.test.ts`, and the
per-fragment `keys` list plus the hardcoded `205` total (**twice**) in
`check-metadata/generic-fragments.test.ts`. Both gates read live from source and compare
against ints in the same test file, so there is no cross-file ordering hazard.

### `npm run docs` is **not** required

Verified from `docs-freshness.test.ts`: the only pinned generated counts are
`guard-rules.md` (`BUILTIN_RULES.length`, currently **116** — CLAUDE.md's "105" is stale),
`quality-checks.md` (`config.quality_checks`, 33 — the external-tool checks, **not** the
inline registry), and `structural-checks.md` (`STRUCTURAL_CHECK_META`, 25). **No generated
markdown carries the inline-registry count.** The `reference_docfreshness_count_gate_ordering`
memory — "edit the generated markdown count FIRST" — applies only to guard rules, quality
checks, structural checks, and sequence detectors, and only on **removal**. For a pure inline
check the two hardcoded-int gates (§9.5, §9.6) both live in the test files themselves, so
there is no cross-file ordering hazard.

## 10. Rollout

### As-built (2026-07-20)

The five detector families + the Bun-regression fixture corpus landed as code
(`4002f22`) but **unwired** — present, tested, callable, contributing nothing to the
live pipeline. This section records the wiring pass and the one deliberate deferral.

**8 of 9 ids wired, all advisory, all `phase: "post"`** (heuristics never `pre_warn`):
the three assert-erasure siblings, both reinterpret detectors, `placeholder_runtime_constant`,
and the two `unsafe-span` checks. Advisory-first per the standing rule; each still surfaces
at PostToolUse (advisory ≠ silent — see §1), so they had to be **clean on our own tree**
before wiring. A self-FP sweep over `src/` (`scratch/selffp-sweep.mts`) gated the decision:

| Detector | Self-hits on `src/` | Action |
|---|---|---|
| assert-erasure ×3, cast_slice, placeholder, unsafe_span ×2 | 0 | wired advisory |
| `unaligned_reinterpret` | 1 → **0** | fixed then wired (below) |
| `regex_from_interpolation` | 17 | **DEFERRED** (below) |

**`unaligned_reinterpret` — fixed, not deferred.** Its one self-hit was
`new Int32Array(new SharedArrayBuffer(4))` in `harness-process-reap.ts` — a
literal-sized fresh buffer has a compile-time-known `byteLength` and is never the
runtime-odd-length class. `JS_ALIGNMENT_GUARD_RE` now treats a nearby
`new (Shared)ArrayBuffer(<literal>)` as a guard. Zero self-hits after; unguarded
runtime-length `.buffer` views still fire (regression tests in
`reinterpret-alignment.test.ts`, "fresh-buffer guard").

**`regex_from_interpolation` — DEFERRED, not wired.** 17 self-hits, and the
classification (`scratch/classify-regex-hits.mts`) shows the exemption model is
genuinely immature, not the code merely noisy: it misses inline `.replace(/…/g,"\\$&")`
escaping, `.map(escapeRe)` escaping, `String.raw` with a pre-escaped `safe` variable, and
intentional glob→regex `.replace(/\*/g,".*")`. Wiring it — even advisory — would warn on
~a dozen correct-by-construction call sites every session, which trains the agent to ignore
the check (the exact failure §1's "advisory ≠ silent" warns about). The detector stays
committed and callable; wiring waits on the §5 v2 declared-parser / escape-recognition
model. This supersedes the old "PR 2 — default gate, dogfoods clean" row, which the audit
disproved.

Deferred beyond regex, with reasons: the **general** interpolate-then-parse class (needs the
declared-parser registry in `discovered-primitives.ts`); the **data-driven token ratchet**
that would let Rust `unsafe`/`unwrap`/`panic!` and Python `# type: ignore` be counted; Rust
`bytemuck`/`align_to` in D2.
