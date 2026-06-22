// ===========================================
// Advisory-skip policy + tool/check tables
// ===========================================
// Central policy for which checks are demoted from the default gate to
// advisory mode (only surfaced under `--all-checks`). The `DEFAULT_ADVISORY_SKIPS`
// set is pinned by a regression test in `__tests__/verify.test.ts` so any
// policy change shows up in the PR diff. Edit both together.

/** Public API — consumed by `verify.ts`, `tool-results.ts`, and tests. */
export const TOOL_IDS = [
	"tsc",
	"biome",
	"eslint",
	"semgrep",
	"gitleaks",
	"dep-audit",
	"mypy",
	"ruff",
	"cargo-check",
	"cargo-clippy",
	"go-build",
	"golangci-lint",
	"c-compile",
	"clang-tidy",
	"oxlint",
	"knip",
	"shellcheck",
	"actionlint",
	"hadolint",
	"taplo",
	"swiftlint",
	"swift-build",
] as const;

/**
 * Public API — consumed by `verify.ts` and `__tests__/verify.test.ts`.
 *
 * Checks demoted to advisory (off by default, available via --all-checks).
 *
 * Selection criteria:
 *   - Heuristic taste/smell checks where false-positive rate is high
 *   - Coverage-style signals useful in a deep audit but noisy as a gate
 *   - Patterns that legitimately appear in correct code (e.g. `catch { log }`
 *     as warn-then-continue)
 *
 * When editing this list, add a rationale for the entry so future readers
 * know why it's advisory. The regression test in `__tests__/verify.test.ts`
 * pins the current set — update it together with this list.
 */
export const DEFAULT_ADVISORY_SKIPS = new Set<string>([
	// Dead-code / coverage scans — valuable in audits, too noisy for default gate.
	"knip",
	"no_test_file",
	"files_without_test",
	// Function size and complexity — heuristic thresholds, frequent FPs on
	// generated templates, barrel files, and long-but-linear code. (The
	// per-file line cap `large_files` was promoted to the default gate in
	// 2026-05 once it learned to exempt generated/test files — see
	// harness/large-file-policy.ts.)
	"complexity",
	"function_arg_count",
	"loop_nesting_depth",
	"nested_ternaries",
	"else_if_chain",
	// Style-level smells — legitimate patterns flagged often enough to noise
	// the gate. Still run under --all-checks for taste reviews.
	"console_statements",
	"missing_return_types",
	"non_null_assertion",
	"require_await",
	"flag_argument",
	"magic_number",
	// Boolean-trap call sites: real readability issue, but legitimate FPs on
	// config-style calls (e.g., `setFeature(name, true, false)` where the
	// booleans correspond to well-known flags). Advisory until FP rate is
	// measured against a broader codebase.
	"boolean_trap",
	// Positional optional boolean: signature-side twin of boolean_trap.
	// Real signal — every call site of `f(x, force?: boolean)` is opaque
	// at the call site — but FP-prone where legacy APIs intentionally
	// preserve positional shape for backwards compat. Ship advisory until
	// diff-attribution lands; otherwise re-firing on every edit of a
	// pre-existing offender amplifies under persistent_warning_escalation
	// (see project_escalation_amplifies_stable_fp).
	"positional_optional_boolean",
	// Many optional params (≥3): real combinatorial-explosion signal but
	// FP-prone on legitimate factory / builder shapes (e.g. fetch wrappers
	// that proxy a handful of optional knobs through). Advisory ride-along
	// with positional_optional_boolean; ratchet to default-gate together
	// once dogfood signal exists.
	"many_optional_params",
	// Same-typed primitive params: orderable-by-mistake nudge toward branded
	// types / struct params. Real bug class, but moderate FP rate — DSL-style
	// curried builders, `(a: string, b: string) => string` formatter helpers,
	// and well-known orderable-by-name pairs that escape the small allowlist
	// will still surface. Advisory until the FP rate is measured against a
	// broader codebase, mirroring boolean_trap's rollout.
	"same_typed_primitive_params",
	// Comment-vs-behavior drift detectors (Mythos blog adaptation). The
	// claims they check ("max N", "returns null", "validates X",
	// "idempotent", "@throws ErrorX") are inherently fuzzy — comments
	// can rot independently of code, and the regex can't model every
	// guard shape. Ship advisory; ratchet to default once FP rate is
	// measured against a broader codebase.
	"comment_claims_limit_no_guard",
	"comment_claims_null_throws_instead",
	"comment_claims_validation_missing",
	"comment_claims_idempotent_mutates",
	"comment_claims_throws_doesnt",
	// Magic-literal-in-conditional: cold-reader clarity signal, but FPs on
	// HTTP status codes, arity checks, and domain enums defined inline in a
	// nearby object literal. Advisory until the detection can consult a
	// named-constants index.
	"magic_literal_in_conditional",
	// write_without_mkdir: real ENOENT bug class, but the function-scope guard
	// scan is heuristic — delegated mkdir (a helper that ensures the dir),
	// module-level dir creation, and existsSync guards in a sibling function
	// all read as "no guard". Advisory until the scan can follow the path
	// variable across call boundaries.
	"write_without_mkdir",
	// duplicated_policy_constant: real drift bug class, but the bare-literal
	// match fires on coincidental reuse (a `7` that is the constant's value but
	// means something unrelated elsewhere in the file). Trivial numbers are
	// excluded, yet domain values still collide. Advisory until the match can
	// consult the literal's syntactic role.
	"duplicated_policy_constant",
	// snapshot_hygiene: zero-FP path match on *.snap.new / *.pending-snap review
	// artifacts; test-integrity taste guard — periodic-sweep concern, not per-edit.
	"snapshot_hygiene",
	// payload_field_casing: heuristic shape match (raw-payload var + known contract
	// field + missing other-casing fallback). Real cross-runner drift bug class, but a
	// single-casing read is correct when only one runner is targeted. Advisory.
	"payload_field_casing",
	// gitignored_written_config: verify-only (needs `git check-ignore`). Real
	// "this file can never be committed" bug class, but only statically-
	// resolvable paths are flagged and the ephemeral-target exclusion list is
	// heuristic. Advisory until path resolution covers more shapes.
	"gitignored_written_config",
	// Unvalidated JSON boundary: real agent-quality issue, but the heuristic
	// "assign + property-access before schema parse" over-flags idiomatic
	// patterns where the parsed value is typed via a separate cast. Advisory
	// until the detection can track type assertions / branded types.
	"unvalidated_json_boundary",
	// Dead exports: legitimate signal, but walks every git-tracked source file
	// on every edit (expensive for large repos) and FPs on public API surfaces
	// consumed by external packages. Advisory until we can honor package.json
	// `exports` maps + skip project-root `index.*` files properly.
	"dead_exports",
	// Untested inverse pair: real property-test-gap signal, but heuristic -- a
	// round-trip test imported under an alias, or living in an integration
	// suite the basename prefilter misses, reads as "untested". Advisory until
	// the test-reference scan is broadened (plan 21).
	"untested_inverse_pair",
	// Untested idempotent: idempotent-shaped function (normalize/sanitize/dedupe)
	// with no property test. Same heuristic / FN-tolerant profile as inverse-pair.
	"untested_idempotent",
	// Lifecycle cleanup: heuristic class-body scan. Real memory-leak signal,
	// but FPs on legitimate patterns (single-shot setTimeout that doesn't
	// need cleanup, delegated cleanup through super.dispose()). Advisory
	// until the detection can see the handle/listener variable across methods.
	"lifecycle_cleanup",
	// Manual field copy: heuristic run-of-5+ scan for hand-copied object
	// fields. Real signal (subset-copy drift) but FPs on deliberate field
	// subsets and renamed-key copies. Advisory while heuristic.
	"manual_field_copy",
	// Cleanup-skipped-on-early-exit: detects setInterval/setTimeout/subscribe
	// /addEventListener acquisitions where a throw or return reaches before
	// the matching release, with no try/finally wrap. Real bug class
	// (Firefox 2024653/2027298 analog) but the regex pairing is conservative —
	// receiver-only matching for addEventListener can over-fire when the
	// same target serves multiple handlers. Advisory until dogfood signal
	// supports promotion.
	"cleanup_skipped_on_early_exit",
	// Tainted-to-privileged-sink: detects req.body/query/params or
	// process.argv/env reaching eval/new Function/vm.run/child_process.exec*/
	// fs.write* without a recognized validator (zod .parse, typeof guard,
	// allow-list .has). Real but heuristic: validators that don't match the
	// recognized list (e.g. project-specific custom validate fns) FP, and
	// the two-step flow analyzer is intra-file scope. Advisory until dogfood
	// signal supports promotion.
	"tainted_to_privileged_sink",
	// await_state_toctou — narrow form of async race detection. Real bugs in
	// `if (state.X) { await...; state.X.method() }` shape, but field/path
	// matching alone produces FPs when the field is repeatedly checked or
	// assigned during the await. Advisory until promotion data exists.
	"await_state_toctou",
	// cleanup_reentrancy — dispose recursion + useEffect-cleanup state
	// mutation. The recursion form is sharp; the useEffect form is heuristic
	// (matches set<Capital>/dispatch in cleanup body). Advisory.
	"cleanup_reentrancy",
	// boundary_copy_no_revalidation — Object.assign / spread of external
	// input into typed slot. Real bug class but FP-prone when the spread
	// merges with already-validated values upstream. Advisory.
	"boundary_copy_no_revalidation",
	// Code clones (DRY): Jaccard token-shingle similarity over function bodies.
	// Real duplication signal, but FP-prone — generated code, boilerplate CRUD
	// handlers, framework lifecycle stubs, and parallel-but-distinct branches
	// (e.g. per-provider adapters) routinely cross the 0.82 threshold without
	// being a genuine refactor opportunity. Advisory until the FP rate is
	// measured against a broader codebase.
	"code_clones",
	// Default-export hygiene: cold-reader/grep clarity signal, but default
	// exports are idiomatic in React/Vue component files and many build
	// configs the filename-matching heuristic can't enumerate. Advisory
	// (deep-audit only) until we can consult project conventions.
	"default_export",
	// Async micro-optimizations — `Promise.all` rewrites are real wins, but
	// the check can't tell when sequencing is intentional (rate limits,
	// ordering guarantees), so it FPs too often to block.
	"sequential_awaits",
	// Catch-block rationale — `catch { log; continue }` is a legitimate
	// warn-then-continue pattern (see src/tools/handlers/docs.ts FTS5
	// fallback, worker-loop reservation renewal). Promote to blocking only
	// when the check can distinguish swallow-and-log from log-and-recover.
	"catch_and_log",
	// Design-shape smells — require human judgment; not reliable as a gate.
	"hybrid_class",
	"fuzzy_responsibility_name",
	"single_implementation_interface",
	"data_clump",
	// Test-body heuristics — high FP rate on parametric / table-driven tests.
	"over_mocking",
	"conditional_in_test",
	"assertion_roulette",
	"test_regressions",
	// Test-quality heuristics — real signal but FP-prone. mock_only_test fires
	// on legitimate fire-and-forget assertions ("the event was emitted") that
	// have no value to check; happy_path_only_test fires on pure-function test
	// files (formatters, getters) that genuinely have no failure path. Advisory
	// until dogfood FP rate is measured.
	"mock_only_test",
	"happy_path_only_test",
	// introverted_test is a static AST dataflow heuristic — helper-inlining is
	// v0-limited, so it stays silent on uncertainty but can still miss/over-fire
	// on unusual SUT-reach patterns. PostToolUse-warn while the FP rate is watched.
	"introverted_test",
	// Error-dispatch-by-instanceof — Effect-TS lessons port
	// (docs/design/effect-ts-harness-additions.md §2.1). `e instanceof Error`
	// inside catch is fragile across realm boundaries — iframes, workers,
	// vm.runInContext — so a real Error from another realm slips through the
	// branch. The bug class only manifests in cross-realm setups, though;
	// single-realm Node code where `instanceof TypeError` legitimately
	// disambiguates a Node-thrown error vs. user error is more common. Ship
	// advisory; promote to default once dogfood signal shows FP rate is low
	// in one-realm projects too.
	"error_dispatch_by_instanceof",
	// CRAP (Change Risk Anti-Patterns) — composite metric of cyclomatic
	// complexity × statement coverage. Requires `coverage/coverage-final.json`
	// (fails open and emits nothing when absent). Line-matching has ±3 slack
	// for edit drift, so post-significant-refactor runs show stale findings
	// until coverage is regenerated. Advisory until threshold+match tolerance
	// are calibrated against real data.
	"crap",
	// UBS division-by-variable (row 30 of Plan 04 phase matrix) — v1 detector
	// "finds division-by-identifier, surfaces, accepts some FPs" per §4.3.
	// Regex literals (`/pattern/i`), URL paths embedded in template literals
	// before stripping, and many legitimate divisions where the agent has
	// already proven the divisor non-zero. Promote out of advisory after one
	// release of telemetry shows FP rate <5%.
	"ubs_division_by_variable",
	// Plan 04 D.1 heuristic-tier (rows 31-41) — every detector below ships
	// `determinism: "heuristic"` and matches on regex shapes that recur in
	// real-world code outside the bug pattern they target. Surfaced under
	// `--all-checks` for taste reviews; not gate-quality. Re-evaluate after
	// a release of telemetry shows per-detector FP rate <10%.
	//   ubs_magic_number_no_const: matches three-digit literals — HTTP status
	//     codes, ports, year literals, retry counts all fire.
	//   ubs_print_debug_leak: `console.log` / `print()` is legitimate for
	//     CLIs and one-shot scripts.
	//   ubs_hardcoded_localhost: dev configs, test fixtures, and example
	//     URLs in docs all contain localhost: ports.
	//   ubs_string_concat_in_loop: heuristic loop-tracking that miscounts
	//     when `} else if {` re-opens, leaving stale `loopDepth`. Often
	//     duplicates the existing `string_concat_in_loop` finding.
	//   ubs_large_function: line-count heuristic; long-but-linear builders
	//     and switch tables routinely exceed it.
	//   ubs_deeply_nested_callback: arrow-function chains in hooks and
	//     promise pipelines look nested but read linearly.
	//   ubs_time_format_locale_dep: most date utilities are intentionally
	//     locale-dependent for display.
	//   ubs_regex_in_loop_no_compile: Python re module caches compiled
	//     patterns transparently; the literal-pattern alarm is misleading.
	//   ubs_numeric_comparison_chain: chained comparisons are idiomatic
	//     in range checks and bounds validation.
	//   ubs_goroutine_no_waitgroup: not every goroutine needs a WaitGroup
	//     (fire-and-forget timers, supervisor patterns).
	//   ubs_defer_in_loop: defer-in-loop is only an issue at high cardinality;
	//     bounded loops with cleanup are fine.
	"ubs_magic_number_no_const",
	"ubs_print_debug_leak",
	"ubs_hardcoded_localhost",
	"ubs_string_concat_in_loop",
	"ubs_large_function",
	"ubs_deeply_nested_callback",
	"ubs_time_format_locale_dep",
	"ubs_regex_in_loop_no_compile",
	"ubs_numeric_comparison_chain",
	"ubs_goroutine_no_waitgroup",
	"ubs_defer_in_loop",
	// === Batch 1 agent-laziness — advisory (heuristic) ===
	// union_widened_with_string: TS-shape heuristic on type-alias declarations.
	// FPs on legitimate branded-string patterns and cross-line unions where the
	// 6-line scan window picks up unrelated type expressions. Promote when the
	// detection can consult tsc's resolved type instead of regex.
	"union_widened_with_string",
	// unbounded_promise_all: line-local heuristic. Can't see whether `<ident>` is
	// bounded by a literal a few lines above. Real signal but moderate FP rate;
	// the suggested fix (p-limit) is right even when the input is bounded.
	"unbounded_promise_all",
	// sync_io_on_hot_path: hot-path detection is dir/path-name based; FPs on
	// utility files that happen to declare a function named `get*` for a
	// non-HTTP purpose. Promote when scope can consult an actual route map.
	"sync_io_on_hot_path",
	// === Batch 5 cross-file — advisory (heuristic) ===
	// empty_body_handler: name-based heuristic over handler-shaped names; FPs
	// on framework router stubs that legitimately delegate to a registry.
	"empty_body_handler",
	// listener_pairing: file-wide presence check; FPs on files where the
	// register/cleanup pair lives in two co-edited files. Promote after
	// scope can see across the immediate import graph.
	"listener_pairing",
	// schema_type_drift: same-file pattern match; FPs on intentionally-narrow
	// types derived from a wider schema (e.g., `Pick<UserSchema, "id">`).
	"schema_type_drift",
	// === CUDA inline checks — advisory (heuristic) ===
	// cuda_kernel_launch_unchecked: every kernel launch should be paired with
	// `cudaGetLastError()`, but single-regex can't see "followed by"; we fire
	// on every launch. Advisory until we can do a tiny lookahead window.
	"cuda_kernel_launch_unchecked",
	// cuda_printf_in_device_code: `.cu` files legitimately mix host (printf
	// is fine) and device code (printf is expensive). Single-regex fires on
	// both. Advisory until we can detect __device__/__global__ context.
	"cuda_printf_in_device_code",
	// === Demoted after dogfood-noise review ===
	// Verify --json on this repo emitted 30+ / 100+ findings each from the
	// checks below — heuristic-tier even though I had originally rated the
	// FP rate as low enough for default-gate. Promote individually only
	// when sustained --all-checks runs show actionable signal:
	//
	// agent_thumbprint_prose: comment-prose phrases ("for now", "in
	// practice", "in production") fire on legitimate engineering comments
	// that aren't agent thumbprints. ~30 hits in this repo's source.
	"agent_thumbprint_prose",
	// untestable_time_in_source: Date.now / new Date() / Math.random /
	// crypto.randomUUID legitimately appear in observability, metrics,
	// telemetry, and id-generation paths that aren't reasonably injected.
	// ~115 hits in this repo, mostly false-positives on those paths.
	"untestable_time_in_source",
	// duplicate_test_names: real signal at high counts but FPs on
	// table-driven test names ("returns 200", "returns 200" inside two
	// distinct describe blocks) and on cross-suite name collisions in
	// large test trees. ~187 hits in this repo, almost all benign.
	"duplicate_test_names",
	// test_missing_sut_import: integration / table-driven / fixture-style
	// tests legitimately don't import the SUT directly; they exercise it
	// through composition. ~108 hits in this repo, vast majority benign.
	"test_missing_sut_import",
	// test_nondeterminism: same structural failure mode as
	// untestable_time_in_source — Date.now / Math.random in tests is
	// often legitimate for measurement / sampling, especially without
	// vi.useFakeTimers (which the check excludes file-wide). Promote
	// after a refinement that distinguishes assertion-bound reads from
	// observation-only reads.
	"test_nondeterminism",
	// demo_data_unmarked: pattern bank fires on test emails / sentinel
	// UUIDs / lorem-ipsum / faker imports that often live in legitimate
	// fixtures, examples, and developer demo paths. The intended use is
	// alongside the @demo-data: directive convention, which most pre-
	// existing code obviously hasn't adopted. Advisory until adoption
	// catches up; the silent_demo_fallback variant remains the higher-
	// signal half of the demo-data system.
	"demo_data_unmarked",
	// test_subprocess_default_timeout: heuristic. Flags an it()/test() that
	// spawns a known-slow subprocess (tsc/biome/npx/tsx/eslint/vitest/the CLI)
	// without an explicit { timeout } — the flaky-test class fixed in the
	// runPerFileChecks / write.test.ts / verify.test.ts wave. Heuristic because
	// brace-matching can't model whether the slow tool actually runs on the
	// hot path of the case (it may sit behind a skipped branch), and a generous
	// suite-level testTimeout in vitest.config can make a per-case timeout
	// redundant. Advisory per CLAUDE.md's heuristic-checks-go-advisory rule;
	// promote once dogfood FP rate is measured.
	"test_subprocess_default_timeout",
	// === Swift / iOS heuristic checks ===
	// swift_unhandled_task_error: scope-tracked across up to 30 lines of a
	// Task body — heuristic on what counts as the "task body" boundary.
	// Real bugs are clearly TPs; closures-returning-Task patterns may FP.
	"swift_unhandled_task_error",
	// swift_global_var_no_isolation: file-scope brace-depth tracking; can
	// FP on `var` inside `extension Module { }` and similar. Stays advisory
	// until measured. Swift 6 strict-concurrency mode catches the same
	// thing at compile-time when it's enabled — this check is the bridge
	// for codebases still on Swift 5 / 5.10 default mode.
	"swift_global_var_no_isolation",
	// swift_self_in_escaping_closure: 20-line lookahead from `@escaping`;
	// misses captures further down and may FP on uses that legitimately
	// don't escape (e.g., the closure runs synchronously before return).
	// Advisory until refined to read the @escaping closure's call shape.
	"swift_self_in_escaping_closure",
	// swift_notification_observer_no_removal: file-scope absence-of-pairing.
	// FPs when the removal lives in a sibling file (rare but real).
	"swift_notification_observer_no_removal",
	// swift_timer_no_invalidate: same file-scope absence-of-pairing heuristic.
	"swift_timer_no_invalidate",
	// swift_combine_no_store: same file-scope absence-of-pairing heuristic.
	// FPs on assign(to: &$published) where the `to:` parameter takes an
	// inout Published and manages its own lifecycle (we still flag).
	"swift_combine_no_store",
	// swift_try_question_discarded: statement-position heuristic. Misses
	// `try?` inside conditionals where the operator is on a separate line;
	// FPs on tools that intentionally use `try?` for fire-and-forget calls.
	"swift_try_question_discarded",
	// swift_fatalerror_in_guard: a taste call — `guard let x = … else
	// { fatalError() }` is a force-unwrap with a better message. Advisory
	// because the message IS sometimes load-bearing for crash triage.
	"swift_fatalerror_in_guard",
	// swift_print_in_view_body: detects body-scope `print()` via brace
	// counting. FPs on `let _ = { print(); return ... }()` patterns where
	// the print is genuinely part of view construction (rare). Advisory
	// until measured.
	"swift_print_in_view_body",
	// swift_abbreviations: pure style enforcement — the most heuristic of
	// the batch. Advisory by design; promotes only if a project opts in.
	"swift_abbreviations",
	// === Coding-standards inline heuristics (2026-06) — advisory ===
	// unjustified_cast: regex over comment/string-stripped content; casts whose
	// safety is obvious from nearby code read as FPs. The net-new ratchet is the
	// real teeth; the verify check is a periodic sweep.
	"unjustified_cast",
	// process_env_outside_config: path/name-based boundary heuristic; FPs on
	// wrapper modules that delegate env parsing to a submodule.
	"process_env_outside_config",
	// top_level_side_effect: column-0 proxy for top-level + name regex; FPs on
	// single-line function definitions whose body names a side-effect call.
	"top_level_side_effect",
]);

/** Public API — consumed by `verify.ts` and `tool-results.ts`. */
export const JS_TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

/**
 * Public API — consumed by `verify.ts`.
 *
 * Merge CLI `--skip` list with the advisory defaults when `--all-checks` is not
 * set. Always returns a lowercased, trimmed set.
 */
export function getEffectiveSkipChecks(
	skipArg: string | undefined,
	allChecks: boolean | undefined,
): Set<string> {
	const merged = new Set(
		skipArg
			? skipArg
					.split(",")
					.map((s: string) => s.trim().toLowerCase())
					.filter(Boolean)
			: [],
	);
	if (!allChecks) {
		for (const check of DEFAULT_ADVISORY_SKIPS) merged.add(check);
	}
	return merged;
}

/**
 * Public API — consumed by `verify.ts`.
 *
 * Narrow a skip-check set to just the tool IDs that can be passed to the
 * CheckEngine's `skipTools` option.
 */
export function getSkipTools(skipChecks: Set<string>): Array<(typeof TOOL_IDS)[number]> {
	return [...skipChecks].filter((check): check is (typeof TOOL_IDS)[number] =>
		(TOOL_IDS as readonly string[]).includes(check),
	);
}
