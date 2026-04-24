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
	// File/function size and complexity — heuristic thresholds, frequent FPs on
	// generated templates, barrel files, and long-but-linear code.
	"large_files",
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
	// Magic-literal-in-conditional: cold-reader clarity signal, but FPs on
	// HTTP status codes, arity checks, and domain enums defined inline in a
	// nearby object literal. Advisory until the detection can consult a
	// named-constants index.
	"magic_literal_in_conditional",
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
	// Circular imports: DFS walk from the edited file — cheap on typical
	// modules but pathologically slow on tightly-connected graph hubs.
	// Advisory until we can cache the walk across edits.
	"circular_imports",
	// Lifecycle cleanup: heuristic class-body scan. Real memory-leak signal,
	// but FPs on legitimate patterns (single-shot setTimeout that doesn't
	// need cleanup, delegated cleanup through super.dispose()). Advisory
	// until the detection can see the handle/listener variable across methods.
	"lifecycle_cleanup",
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
	// CRAP (Change Risk Anti-Patterns) — composite metric of cyclomatic
	// complexity × statement coverage. Requires `coverage/coverage-final.json`
	// (fails open and emits nothing when absent). Line-matching has ±3 slack
	// for edit drift, so post-significant-refactor runs show stale findings
	// until coverage is regenerated. Advisory until threshold+match tolerance
	// are calibrated against real data.
	"crap",
]);

/** Public API — consumed by `verify.ts` and `tool-results.ts`. */
export const LARGE_FILE_THRESHOLD = 800;

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
