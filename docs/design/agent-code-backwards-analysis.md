# Agent-code backwards analysis — replaying the check registry over real agent output

Status: measurement only. No detector in `src/` was modified. All prototype
code lives in `scratch/ubs-parity/` (gitignored) and is throwaway.

## 1. Method

**Source: `.interlinked/timeline.jsonl` only**, streamed line-by-line
(`readline` over a `createReadStream`, never buffered whole) — the entire
file, 56,596,961 bytes / 31,098 lines, read once. `timeline.jsonl` was chosen
over `activity.jsonl` (207MB) and `collection.jsonl` (111MB, `action.command`
is shell text, not Write/Edit payloads) because it is the one file that
carries both providers' actual code payloads with an explicit `provider` tag
per session:

- **claude-code**: `tool_name` `Write`/`Edit`/`MultiEdit`, `tool_input` a
  structured object (`content` for Write, `new_string` per edit).
- **codex**: `tool_name` `apply_patch`, `tool_input` a *string* in a custom
  `*** Begin Patch / *** Update File: <path> / @@ ... / *** End Patch` format
  (not a unified diff). Extraction parses this format
  (`scratch/ubs-parity/extract-corpus.mts::parseApplyPatch`): `*** Add File`
  sections are all `+`-prefixed lines, so the reconstruction **is** the
  complete new file; `*** Update File` sections only recover the `+`-prefixed
  hunk lines — the new/changed lines, not the whole file. Those records are
  tagged `kind: "patch_update"` and are snippets, same caveat as an Edit.

Older `timeline.v1` rows predate the `provider` field (added alongside the
codex collector); those were backfilled by schema fingerprint — claude-code
rows always carry `version`/`git_branch`, codex rows carry a `gpt-*` `model`
and neither. Records were deduplicated on a SHA-256 of `(file_path, content)`
(not MD5/SHA-1 — `ubs_weak_hash` correctly objected to the first draft, which
used SHA-1 as a plain cache key; switched rather than suppressed).

Only the 13 extensions the task specified were kept: `.ts .tsx .js .jsx .py
.rs .go .java .rb .swift .c .cpp .cs`. Payloads under 5 characters (post-trim)
were dropped as noise.

Extractor: `scratch/ubs-parity/extract-corpus.mts` → `scratch/ubs-parity/agent-code-corpus.jsonl`.

### Corpus size

| Metric | Value |
|---|---|
| Lines read (whole file) | 31,098 |
| Payloads extracted | **1,960** |
| Duplicates skipped | 120 |
| Total content bytes | 2,506,453 (~2.4 MB) |
| Parse errors | 0 |

**By provider:**

| Provider | Payloads |
|---|---:|
| claude-code | 1,953 |
| codex | 7 |

**By extension:**

| Ext | Payloads |
|---|---:|
| .ts | 1,939 (98.9%) |
| .py | 15 |
| .js | 6 |

**By kind** (how much of the corpus is a full file vs. a fragment):

| Kind | Count | Full file? |
|---|---:|---|
| `edit` (Edit `new_string`) | 1,652 | No — a changed span, not the file |
| `write` (Write `content`) | 301 | Yes — complete file at write time |
| `patch_update` (codex hunk) | 7 | No — changed lines only |
| `patch_add` (codex new file) | 0 | — (none of the 8 `apply_patch` calls in this file created a new file) |

**This corpus is a hard skew toward one repo, one language, one dominant
provider, and mostly-fragment content — every number below should be read
through that lens** (expanded in §5).

## 2. Replaying the shipped registry

`src/harness/check-registry/index.ts` exports `CHECK_REGISTRY`: **253 inline
checks**, each `(content, filePath) => InlineMatch[]`. Every check was run
against every one of the 1,960 corpus payloads (496,880 calls; wall clock
~10 min on a heavily loaded machine — see runner notes below).
Five checks (`endpoint_auth_missing`, `endpoint_idor_shape`,
`endpoint_missing_tenant_filter`, `endpoint_ssrf_shape`,
`endpoint_mass_assignment`) use a non-standard adapter signature that builds
a per-project route/dependency graph on first call; they completed cleanly in
the full run (0 findings) but stalled for minutes on a machine under heavy
concurrent load when re-run in isolation — a fragility worth knowing about
independent of this analysis (they are not safely batch-callable under
resource contention the way the other 248 checks are).

Runner: `scratch/ubs-parity/replay-checks.mts` → `scratch/ubs-parity/replay-results.json`.

**Checks fired: 51 / 253 (20%). Checks that NEVER fired: 202 / 253 (80%).**

### Top 15 by fire rate (payloads, not raw finding count)

| # | Check | Payloads | Findings | Phase / severity | Example |
|---|---|---:|---:|---|---|
| 1 | `test_missing_sut_import` | 440 | 440 | post / warning | see caveat below — **likely a corpus artifact** |
| 2 | `unjustified_cast` | 92 | 167 | post / warning | `src/harness/build-refresh.test.ts:93` |
| 3 | `function_arg_count` | 89 | 130 | post / warning | `src/harness/evaluator/pre-tool-guards.ts:2` |
| 4 | `ubs_magic_number_no_const` | 70 | 113 | post / warning | `src/harness/spec/types.ts:151` |
| 5 | `assertion_free_test` | 54 | 54 | **pre_block / error** | `src/harness/__tests__/evaluator.test.ts:68` |
| 6 | `same_typed_primitive_params` | 48 | 68 | post / warning | `src/harness/large-file-policy.ts:24` |
| 7 | `cognitive_complexity` | 37 | 54 | post / warning | `src/harness/spec/extract-ids.ts:26` |
| 8 | `dead_exports` | 31 | 46 | post / warning | `src/harness/spec/binding.ts:19` |
| 9 | `non_deterministic_test` | 30 | 79 | post / warning | `src/harness/build-refresh.test.ts:4` |
| 10 | `write_without_mkdir` | 29 | 55 | post / warning | `src/harness/spec/ledger.test.ts:172` |
| 11 | `conditional_in_test` | 25 | 28 | post / warning | `src/harness/evaluator/__tests__/post-tool.test.ts:17` |
| 12 | `nested_ternaries` | 23 | 24 | post / warning | `src/harness/spec/extract-ids.ts:201` |
| 13 | `data_clump` | 20 | 25 | post / warning | `src/commands/findings.ts:43` |
| 14 | `code_clones` | 19 | 78 | post / warning | `src/harness/spec/extract-ids.ts:327` |
| 15 | `ubs_print_debug_leak` | 19 | 64 | post / warning | `scratch/fix_assembly.py:85` |

**The #1 result needs its asterisk up front.** `test_missing_sut_import`
fires whenever a `.test.ts` payload contains no import of its companion
module — real for a `Write` (full file), but **spurious for the 1,652 `Edit`
snippets**, which by construction lack the file's import section regardless
of whether the real file imports its SUT. All three sampled examples fire at
`:1` (the snippet's first line), consistent with "no imports visible in this
fragment" rather than "this test genuinely never imports its SUT." Read this
row as *"fires constantly on Edit-shaped input,"* not *"this repo has 440
untested-import test files."* This is the single clearest lesson from the
exercise: **checks that reason about file-level structure (imports, exports,
class shape) need to be replayed against `kind: "write"`/`kind: "patch_add"`
payloads only** — full files — or their real-world rate is inflated by
however many Edit payloads happen to lack the relevant top-of-file context.
(An isolated `kind=write`-only rerun was attempted but repeatedly stalled on
`endpoint_auth_missing`'s one-time route-map build under the machine's load —
see the fragility note above — so this caveat is qualitative, not a second
verified number; the qualitative direction is unambiguous from the `:1`
line-number pattern alone.)

The rest of the top 15 read as genuine signal: `unjustified_cast`,
`function_arg_count`, `ubs_magic_number_no_const`, `same_typed_primitive_params`,
`cognitive_complexity`, `dead_exports`, `nested_ternaries`, `data_clump`, and
`code_clones` are all checks that can legitimately fire inside a partial
snippet (they inspect a local span, not file-level structure), and their
counts land in a believable range for ~600 hand-written source files.
`assertion_free_test` firing 54 times as a `pre_block` **error** is worth a
second look on its own — it means 54 payloads in this corpus *would have
blocked the write* had the tolerant-gate reasoning not applied (the
`pre_block` gate is introduced-only vs. the on-disk baseline, so most of
these were pre-existing, not blocked in practice).

### Full fire table (51 checks, all severities)

| Payloads | Findings | Check | Phase | Severity |
|---:|---:|---|---|---|
| 440 | 440 | `test_missing_sut_import` | post | warning |
| 92 | 167 | `unjustified_cast` | post | warning |
| 89 | 130 | `function_arg_count` | post | warning |
| 70 | 113 | `ubs_magic_number_no_const` | post | warning |
| 54 | 54 | `assertion_free_test` | pre_block | error |
| 48 | 68 | `same_typed_primitive_params` | post | warning |
| 37 | 54 | `cognitive_complexity` | post | warning |
| 31 | 46 | `dead_exports` | post | warning |
| 30 | 79 | `non_deterministic_test` | post | warning |
| 29 | 55 | `write_without_mkdir` | post | warning |
| 25 | 28 | `conditional_in_test` | post | warning |
| 23 | 24 | `nested_ternaries` | post | warning |
| 20 | 25 | `data_clump` | post | warning |
| 19 | 78 | `code_clones` | post | warning |
| 19 | 64 | `ubs_print_debug_leak` | post | warning |
| 17 | 34 | `raw_control_bytes` | pre_block | error |
| 16 | 22 | `untestable_time_in_source` | post | warning |
| 12 | 14 | `loop_nesting_depth` | post | warning |
| 12 | 13 | `empty_catch` | pre_block | warning |
| 11 | 11 | `happy_path_only_test` | post | warning |
| 9 | 13 | `process_env_outside_config` | post | warning |
| 9 | 9 | `ubs_string_concat_in_loop` | post | warning |
| 9 | 9 | `magic_number` | post | warning |
| 8 | 24 | `duplicated_policy_constant` | post | warning |
| 7 | 7 | `default_export` | post | warning |
| 6 | 9 | `redos_catastrophic` | post | warning |
| 6 | 7 | `nan_coercion_guard` | post | warning |
| 6 | 7 | `test_nondeterminism` | post | warning |
| 6 | 6 | `unvalidated_json_boundary` | post | warning |
| 6 | 6 | `procfs_probe_in_test` | post | warning |
| 4 | 5 | `json_parse_unsafe` | post | warning |
| 4 | 4 | `magic_literal_in_conditional` | post | warning |
| 4 | 4 | `cleanup_skipped_on_early_exit` | post | warning |
| 4 | 4 | `assertion_roulette` | post | warning |
| 3 | 8 | `type_smuggling` | post | warning |
| 3 | 4 | `ubs_division_by_variable` | post | warning |
| 3 | 3 | `self_import` | pre_block | error |
| 3 | 3 | `ubs_js_loose_equality` | pre_warn | warning |
| 3 | 3 | `ubs_large_function` | post | warning |
| 2 | 5 | `double_cast_unknown` | post | warning |
| 1 | 3 | `top_level_side_effect` | post | warning |
| 1 | 2 | `boolean_trap` | post | warning |
| 1 | 2 | `flag_argument` | post | warning |
| 1 | 1 | `cjs_in_esm_module` | post | warning |
| 1 | 1 | `iterator_invalidation` | post | warning |
| 1 | 1 | `boundary_copy_no_revalidation` | post | warning |
| 1 | 1 | `comment_claims_validation_missing` | post | warning |
| 1 | 1 | `payload_field_casing` | post | warning |
| 1 | 1 | `ubs_weak_random_security` | post | warning |
| 1 | 1 | `introverted_test` | post | warning |
| 1 | 1 | `demo_data_unmarked` | post | warning |

## 3. NEVER FIRED — 202 / 253 checks (80%)

Grouping by why, not just listing 202 ids:

**Wrong language for this corpus — 44 `ubs_*` + 23 more (67 total, ~1/3 of
all never-fired).** The corpus is 99% `.ts`. Checks scoped to Python-only,
Go-only, Rust-only, Java-only, C-only, or Swift-only source cannot fire
against a `.ts`/`.py`(×15)/`.js`(×6) corpus almost by construction:

- All ~18 `swift_*` checks (0 Swift files in corpus)
- `c_unsafe_functions`, `c_include_guard`, `c_sprintf_usage` (0 C files)
- `rust_unsafe_span`, `rust_test_nondeterminism` (0 Rust files)
- Most of the 44 never-fired `ubs_*` ids: `ubs_mutex_lock_unwrap` (Rust),
  `ubs_goroutine_no_waitgroup`/`ubs_defer_in_loop` (Go),
  `ubs_java_optional_get`/`ubs_java_assert_side_effect` (Java),
  `ubs_python_assert_tautology`/`ubs_python_mutable_default_arg`/
  `ubs_pickle_untrusted_load`/`ubs_marshal_load`/`ubs_shelve_open`/
  `ubs_yaml_unsafe_load`/`ubs_tempfile_mktemp_race` (Python — and the corpus
  has only 15 Python payloads total, so even Python-scoped checks had a thin
  sample to fire against)

**Wrong artifact type — 8 `spec_*` checks** (`spec_dangling_anchor`,
`spec_numbering`, `spec_count_claim`, `spec_pitfall`, `spec_claim_untagged`,
`spec_capacity_claim`, `spec_table_sum`, `spec_stage_order`) target Markdown
spec/design docs, not source code — this corpus extracted only the 13 code
extensions, so no Markdown ever reached them. Not evidence of anything.

**Endpoint-security family — 5 checks, genuinely evaluated, genuinely 0.**
`endpoint_auth_missing`, `endpoint_idor_shape`, `endpoint_missing_tenant_filter`,
`endpoint_ssrf_shape`, `endpoint_mass_assignment` ran to completion in the
full-corpus pass (see fragility note in §2) and found nothing — plausible: this
is a CLI + local Unix-socket daemon, not an HTTP API surface with many
authenticated routes, so the shapes these checks look for are rare in this
codebase by nature, not by corpus bias.

**The remaining ~124 checks are TS-applicable and simply never fired in this
corpus.** This is the group worth actually reading names from — every check
below is scoped to extensions the corpus has plenty of (`.ts`/`.js`) and had
a fair shot: `misused_promises`, `async_promise_executor`, `eval_usage`,
`inner_html`, `nan_comparison`, `throw_literal`, `promise_reject_non_error`,
`unsafe_optional_chaining`, `dangerously_set_inner_html`,
`child_process_exec_user_input`, `cookie_missing_security_flags`,
`logger_format_user_input`, `disabled_tests`, `focused_tests`,
`migration_ordering`, `tautological_assertion`, `mocking_the_sut`,
`circular_imports`, `lifecycle_cleanup`, `snapshot_hygiene`,
`discriminated_union_exhaustiveness`, `floating_promises`, `non_null_assertion`,
`fetch_without_timeout`, `unbounded_promise_all`, `sync_io_on_hot_path`,
`real_io_in_tests`, `mock_only_test`, `over_mocking`, `duplicate_test_names`,
`resource_handle_leak`, `law_of_demeter`, `commented_out_code`, and ~90 more
(full list in `scratch/ubs-parity/replay-results.json`). None of these fired
even once across 1,960 real edit/write payloads from this repo's history.
That is a real, if narrow, data point — see §5 for why it is not, by itself,
grounds to cut any of them.

## 4. UBS-gap prototypes — would-have-fired scoring

`docs/design/ubs-parity-gap.md` now exists (landed by a parallel session
during this analysis) and names **39 hook-feasible MISSING classes** in its
§4. Of those, roughly 20 are explicitly scoped to Go/Rust/Java/C++/C#/Ruby/
Elixir source per the gap doc's own "UBS source" column — since this corpus
has **zero** files in any of those languages, a prototype for e.g. "Go
`defer Close()` ordering" would mechanically score 0 here, which would tell
us nothing we don't already know (this repo has no Go files). Prototyped
instead: the **14 JS/TS-applicable or generically-applicable** MISSING
classes, where a real signal was actually possible.

Prototype source: `scratch/ubs-parity/replay-prototypes.mts` (detectors +
runner, single file — kept self-contained after a sibling-file import tripped
`tsconfig.json`'s `rootDir: "src"` constraint on the tsc diff-overlay guard).
Output: `scratch/ubs-parity/proto-results.json`.

| Payloads | Findings | Candidate | Gap-doc class |
|---:|---:|---|---|
| 23 | 37 | `proto_index_arith_no_bounds_check` | Index arithmetic `arr[i±1]` without bounds check |
| 2 | 3 | `proto_var_instead_of_let_const` | `var` instead of `let`/`const` — **see caveat below** |
| 0 | 0 | `proto_postmessage_no_origin_check` | postMessage/message-event listener without origin check |
| 0 | 0 | `proto_response_header_injection` | Response header injection from request data |
| 0 | 0 | `proto_timing_unsafe_secret_compare` | Timing-unsafe secret/token comparison |
| 0 | 0 | `proto_cors_credentialed_wildcard` | CORS credentialed wildcard |
| 0 | 0 | `proto_host_header_trusted_url` | Host header trusted for absolute URL construction |
| 0 | 0 | `proto_jwt_verify_bypass` | JWT verification bypass |
| 0 | 0 | `proto_prototype_pollution` | Prototype pollution |
| 0 | 0 | `proto_unbounded_body_no_size_cap` | Unbounded request body / JSON decode without size cap |
| 0 | 0 | `proto_finally_early_exit` | return/break/continue inside finally |
| 0 | 0 | `proto_debugger_statement_left` | `debugger` statement left in code |
| 0 | 0 | `proto_large_inline_literal` | Large inline arrays/objects |
| 0 | 0 | `proto_insecure_chmod_mode` | Insecure/weak filesystem permission modes |

**Only one candidate shows a real signal: `proto_index_arith_no_bounds_check`
(23 payloads, 37 findings).** Spot-checked against `src/harness/spec/assembly-score.ts`:
`seq[i + 1]` at line 54 has no bounds guard on that line (a loop-invariant
guard several lines up may or may not cover it — the heuristic is same-line
only, so this is a plausible-but-unverified true-positive rate, not a proven
one), while a sibling line 78 (`if (i + 1 < seq.length && ...)`) is correctly
excluded because the guard is on the same line. This is the class the gap
doc flagged as a **real, narrow gap** distinct from the existing
`index_bounds_unchecked` (which only fires on provably-tainted external
input) — the measurement here is consistent with that: 23 real occurrences
of unguarded arithmetic-in-subscript in this repo's own agent-written code,
none of which the shipped `index_bounds_unchecked` would have caught (it
requires a taint trace this shape doesn't have).

**`proto_var_instead_of_let_const`'s 2 firings do NOT hold up on inspection —
recorded here as a negative result, not a candidate.** Both are false
positives from the naive regex matching the *word* "var" inside prose, not
an actual `var` declaration: `src/commands/experience.test.ts:6` is a code
comment ("...after macOS resolves the `/var` → `/private/var` symlink.") and
`src/harness/checks/agent-safety-async.test.ts:199` is a `describe()` title
string ("...const/let/var arrow-assignment form") that names the pattern
being tested, not one being written. A real `var`-detector needs at minimum
a string/comment-aware tokenizer, which this 20-minute prototype doesn't
have — the gap-doc entry itself is plausible (UBS's version presumably does
better), but this particular throwaway measurement undercounts the false
positive rate rather than proving a signal. Included for honesty: a
would-have-fired count without a false-positive check is not evidence.

The other 12 prototypes scored **zero** against this corpus. Read this the
same way as the never-fired registry checks in §3 — that is a "not present
in this repo's history" result, not a "this class doesn't matter" result:
this is a local CLI + Unix-socket daemon with almost no HTTP-request-handling
surface (`src/lib/viz/` is the one exception, a small local-only SSE
dashboard), so request-derived classes (header injection, CORS, JWT, host
header trust, prototype pollution via `req.*`, unbounded body size) had
essentially no attack surface to fire against in this codebase regardless of
detector quality. `debugger` and large-inline-literal scoring zero is a more
genuine "didn't happen here" signal — those apply to any JS/TS file, not
just request handlers, and a 5-file-avg-1.3KB corpus of real edits simply
never contained either.

## 5. Corpus bias — read every number above through this lens

- **One repo, overwhelmingly one language.** 1,939/1,960 payloads (99%) are
  `.ts`. A check with zero fires here may be exactly the check that catches
  the next Python/Go/Rust/Java/Ruby/Elixir/C#/Swift bug in a *different*
  repo — the corpus cannot speak to those languages at all, and 67 of the
  202 never-fired checks are scoped to languages this corpus barely or never
  contains.
- **84% of the corpus is fragments, not files.** 1,652/1,960 payloads are
  `Edit.new_string` — a changed span, not the whole file. Checks that reason
  about file-level structure (imports, exports, whole-class shape) will read
  as over- or under-firing relative to their true real-file rate; this
  analysis surfaced one concrete case (`test_missing_sut_import`, §2) and the
  same distortion likely affects any other check gated on "no X anywhere in
  this file" logic. Only 301 payloads (15%) are known-complete files.
- **One session dominates.** With 1,953/1,960 (99.6%) of payloads from
  claude-code and only 7 from codex, this analysis says almost nothing about
  fire rates on codex-authored code specifically — the 6,876 `codex`-tagged
  timeline rows referenced in CLAUDE.md's collector note are overwhelmingly
  `exec`/`exec_command` (shell) calls against *other* repos (`mcp-client-bio`
  cwd observed repeatedly), not `apply_patch` calls against this one.
- **Do not delete a check because it never fired here.** A 0-count in this
  table is "not exercised by this repo's history," which is one Boolean bit
  of evidence, not a verdict on the check's value elsewhere. The Check
  Evidence Contract (CLAUDE.md, `src/harness/check-evidence/`) already
  requires labeled positive/negative test cases independent of this kind of
  corpus measurement — that remains the right bar for keeping or cutting a
  check, not this document.

## 6. Artifacts

| Path | Contents |
|---|---|
| `scratch/ubs-parity/extract-corpus.mts` | Corpus extractor (timeline.jsonl → JSONL) |
| `scratch/ubs-parity/agent-code-corpus.jsonl` | 1,960 extracted payloads |
| `scratch/ubs-parity/replay-checks.mts` | Registry replay runner |
| `scratch/ubs-parity/replay-results.json` | Full 253-check ranked results |
| `scratch/ubs-parity/replay-prototypes.mts` | 14 UBS-gap prototype detectors + runner |
| `scratch/ubs-parity/proto-results.json` | Prototype ranked results |

All gitignored, all reproducible: `npx tsx scratch/ubs-parity/extract-corpus.mts`
then `npx tsx scratch/ubs-parity/replay-checks.mts` /
`npx tsx scratch/ubs-parity/replay-prototypes.mts`.
