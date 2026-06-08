// Shared helpers used by all check modules.
// Extracted from generic-checks.ts. These are internal to the checks/ package.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripCommentsAndStrings } from "./shared-text-utils.js";

/** A single match found by an inline check. Public API — re-exported by generic-checks.ts. */
export interface InlineMatch {
	/** 1-based line number */
	line: number;
	/** Trimmed text of the matching line (truncated to 150 chars) */
	text: string;
}

/**
 * JS/TS extension set (includes .mts/.cts). Used across many checks.
 * Prefer JS_TS_ALL_EXTS (array) when you need `Array.includes`.
 */
export const JS_TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

/** JS/TS extension array — same values as JS_TS_EXTS but ordered for `.includes()`. */
export const JS_TS_ALL_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts"];

/**
 * Collect a full function signature starting at the given line index.
 * Reads up to 20 lines or until we see `{` or `=>`, whichever comes first.
 * Used by missing-return-type, complexity, and taste-level checks.
 */
export function collectFunctionSignature(lines: string[], startIdx: number): string {
	let sig = "";
	for (let i = startIdx; i < Math.min(startIdx + 20, lines.length); i++) {
		const line = lines[i];
		if (line === undefined) break;
		sig += ` ${line}`;
		if (line.includes("{") || line.includes("=>")) break;
	}
	return sig;
}

/**
 * Count top-level parameter items, respecting nested angle brackets, parens,
 * brackets, and braces. Returns the number of comma-separated items at the
 * top level. (Despite the name, this returns the COUNT of items, not the
 * count of commas — an empty string still returns 1. Kept as-is for
 * backwards-compatibility with callers like `checkFunctionArity`.)
 */
export function countTopLevelCommas(paramStr: string): number {
	let depth = 0;
	let count = 1;
	for (const ch of paramStr) {
		if (ch === "<" || ch === "(" || ch === "{" || ch === "[") depth++;
		else if (ch === ">" || ch === ")" || ch === "}" || ch === "]") depth--;
		else if (ch === "," && depth === 0) count++;
	}
	return count;
}

// ===========================================
// Helper: Test File Detection
// ===========================================

/**
 * Resolve the interlinked-cli package root once, lazily, by walking up from
 * this module's location until we hit a `package.json` whose `name` matches.
 * Used to scope harness-internal test-file exemptions to OUR files only —
 * a user repo that happens to have a `harness/rules/` directory must not
 * silently inherit the exemption.
 *
 * Returns `null` when the package root can't be located (unusual install
 * paths, broken layouts). Treated as fail-closed by callers: when null,
 * the exemption never fires.
 */
let _packageRootCache: string | null | undefined;
function resolveInterlinkedCliPackageRoot(): string | null {
	if (_packageRootCache !== undefined) return _packageRootCache;
	try {
		const moduleDir = dirname(fileURLToPath(import.meta.url));
		let dir = moduleDir;
		// Bound the walk so a runaway loop on weird filesystems can't hang.
		// 8 hops is comfortably more than any realistic install layout
		// (`<root>/dist/harness/checks/` is 4; npm/pnpm symlinked layouts
		// add a couple more).
		for (let i = 0; i < 8; i++) {
			const pkgPath = join(dir, "package.json");
			if (existsSync(pkgPath)) {
				try {
					const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
						name?: unknown;
					};
					if (pkg && pkg.name === "interlinked-cli") {
						_packageRootCache = dir;
						return dir;
					}
				} catch (e) {
					// Malformed package.json — keep walking. Swallowing here
					// matches the resolver's contract (returns null on
					// failure); callers fail-closed.
					void e;
				}
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	} catch (e) {
		// `import.meta.url` resolution failure — extremely rare, but if it
		// happens we silently fall through to fail-closed (returns null).
		void e;
	}
	_packageRootCache = null;
	return null;
}

/**
 * Test-only override hook for the package-root cache. Lets unit tests
 * exercise both the "we are running on interlinked-cli source" and the
 * "we are running on a user repo" branches without filesystem mutation.
 */
export function __setPackageRootForTesting(root: string | null | undefined): void {
	_packageRootCache = root;
}

/**
 * Check if a file path looks like a test file.
 * Matches common conventions across languages:
 * - Python: `test_*.py`, `*_test.py`
 * - Go: `*_test.go`
 * - JS/TS: `*.test.ts`, `*.spec.ts`, `*.test.js`, `*.spec.js`
 * - Directories: `__tests__/`, `tests/`, `src/test/`
 *
 * Also returns true for our own harness rule-definition and check-registry
 * files. Those files contain dangerous-looking patterns AS DATA (regex
 * strings about shell commands, registry of patterns we want to detect,
 * `chmod 777` examples in rule descriptions) — content-quality scans on
 * them produce only false positives. Treating them as test-equivalents
 * means every detector that already exempts test files also exempts the
 * rules registry without each one having to re-implement the check.
 *
 * The harness-internals exemption is scoped to interlinked-cli's own
 * package via `resolveInterlinkedCliPackageRoot()`. A user project whose
 * source happens to live under `harness/rules/` or `harness/check-registry/`
 * does NOT inherit the exemption.
 */
/** interlinked-cli's OWN detector / data source files, where dangerous-looking
 *  or test-like patterns appear AS DATA (regex catalogs, rule descriptions,
 *  secret-shaped example strings, the STUB_PATTERNS regexes). Scoped to the
 *  package's own root (resolved once via `resolveInterlinkedCliPackageRoot`) so
 *  a user repo with its own `harness/rules/` directory is unaffected.
 *  Fail-closed: when the resolver returns null, the exemption never fires.
 *
 *  Content scans gate `if (isTestFile) return []`, so routing these files
 *  through the broad `isTestFile` makes those scans skip them. But test-hygiene
 *  checks gate the OPPOSITE way (`if (!isStrictTestFile) return []`), so they
 *  must NOT see these as test files — that conflation is what made
 *  `duplicate_test_names` fire on the `it.skip(` examples inside
 *  verification-stop-checks.ts. Hence the strict/broad split. */
function isHarnessInternalDataFile(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	const pkgRoot = resolveInterlinkedCliPackageRoot();
	if (!pkgRoot || !normalized.startsWith(`${pkgRoot.replace(/\\/g, "/")}/`)) {
		return false;
	}
	return (
		normalized.includes("/harness/rules/") ||
		normalized.includes("/harness/check-registry/") ||
		normalized.includes("/harness/check-metadata") ||
		// The whole checks/ tree is detector implementations: each file holds
		// the very patterns it detects (test-card numbers, fake-data strings,
		// chmod/SQL/ReDoS examples) AS DATA, so the regex-driven content-quality
		// scans only ever false-positive on them. Covers shared.ts (home of
		// this very exemption) too.
		normalized.includes("/harness/checks/") ||
		normalized.includes("/harness/evaluator/write-content-guards.") ||
		// signatures.ts re-exports the rule tables; signatures-patterns.ts is
		// where the PI regexes + descriptions actually live (e.g. the
		// `/ignore (all )?(previous|prior|above) (instructions?...)/` literal
		// and the `sig-pi-system-override` text). Both hold the very patterns
		// the daemon's PI content scan matches AS DATA — editing
		// signatures-patterns.ts would otherwise trip the scan on its own
		// detection literals and block the write.
		normalized.includes("/harness/signatures-patterns.") ||
		normalized.includes("/harness/signatures.") ||
		// secret-detection.ts is the secret detector itself — its regex literals
		// and example-key references are secret-shaped strings AS DATA.
		normalized.includes("/harness/quality-checks/secret-detection.") ||
		// verification-stop-checks.ts defines STUB_PATTERNS — regexes that hold
		// "TODO" / "FIXME" / "not implemented" / "stub" as detection DATA, plus
		// `it.skip(` / `test.skip(` example strings in comments.
		normalized.includes("/harness/verification-stop-checks.") ||
		// guards-inline.ts is the inline-fallback guard TEMPLATE: its body is the
		// generated hook script and holds chmod/rm/kill regexes as DATA.
		normalized.includes("/hook-template-chunks/guards-inline.")
	);
}

/** STRICT test-file detection — directory + filename conventions ONLY, no
 *  harness-internal-data exemption. Use this when a check should run *only* on
 *  genuine test files (every test-hygiene / test-quality check). The broad
 *  `isTestFile` additionally returns true for interlinked-cli's own data files
 *  so content scans skip them — but that exemption must NOT make a test-hygiene
 *  check fire on a data file. */
export function isStrictTestFile(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");

	// Directory-based detection
	if (
		normalized.includes("/__tests__/") ||
		normalized.includes("/tests/") ||
		normalized.includes("/src/test/")
	) {
		return true;
	}

	// Filename-based detection
	const fileName = normalized.split("/").pop() || "";

	// Python: test_*.py or *_test.py
	if (fileName.startsWith("test_") && fileName.endsWith(".py")) return true;
	if (fileName.endsWith("_test.py")) return true;

	// Go: *_test.go
	if (fileName.endsWith("_test.go")) return true;

	// JS/TS: *.test.ts, *.spec.ts, *.test.js, *.spec.js, *.test.tsx, *.spec.tsx, etc.
	if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(fileName)) return true;

	// Java: *Test.java, *Tests.java
	if (/Tests?\.java$/.test(fileName)) return true;

	// Swift: *Tests.swift, *Test.swift, test_*.swift
	if (/Tests?\.swift$/.test(fileName)) return true;
	if (fileName.startsWith("test_") && fileName.endsWith(".swift")) return true;

	return false;
}

/** BROAD test-or-exempt predicate — BEHAVIOR-PRESERVING vs the pre-split
 *  `isTestFile`. True for genuine test files AND for interlinked-cli's own
 *  data / detector files. Content scans gate `if (isTestFile) return []` on
 *  this so they skip both. Checks that must run ONLY on genuine test files use
 *  `isStrictTestFile` instead, so the data-file exemption can't make them
 *  fire (the `duplicate_test_names`-on-`verification-stop-checks` FP). */
export function isTestFile(filePath: string): boolean {
	return isStrictTestFile(filePath) || isHarnessInternalDataFile(filePath);
}

/**
 * Check if a file path lives in a vendored, generated, or test-fixture
 * tree where security-style detectors produce only false positives.
 *
 * Origin: a 139-repo FP audit found that the bulk of the noise from
 * checks like `ubs_sql_string_concat`, `ubs_eval_input_tainted`, and
 * `ubs_subprocess_shell_true` came from `node_modules/`, `vendor/`,
 * `examples/`, `dist/`, minified bundles, and similar trees that the
 * agent does not author. These directories carry SQL, `eval`, and
 * shell calls as DATA — they're snapshots of upstream code, not new
 * code we want to vet.
 *
 * Distinct from `isTestFile`: a project's own test sources DO get
 * checked (legit auth tests can hide real bugs); only vendored /
 * generated / fixture trees are exempted here. Security checks call
 * BOTH `isTestFile` and this helper at their gate.
 *
 * Returns true when the normalized path matches any of:
 * - dependency / vendored: `node_modules/`, `vendor/`, `third_party/`
 * - example / fixture trees: `examples/`, `environments/`, `fixtures/`,
 *   `seed-data/`, `seeds/`, `mocks/`, `__mocks__/`, `test-data/`,
 *   `testdata/`
 * - generated / build output: `dist/`, `build/`, `.next/`, `coverage/`
 * - bundled / minified asset filenames: `*.min.{js,css,mjs,cjs}`,
 *   `*.bundle.{js,css,mjs,cjs}`
 */
export function isVendoredOrFixturePath(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");

	// Directory-segment matches. Each pattern is "(start-of-string OR
	// preceding slash) followed by `<dir>/`" — so `vendor/x` and
	// `pkg/vendor/x` both match, but `myvendor/x` (no slash boundary
	// before `vendor`) does not.
	const dirRe =
		/(^|\/)(?:vendor|third_party|node_modules|environments|examples|fixtures|seed-data|seeds|mocks|__mocks__|test-data|testdata|dist|build|\.next|coverage)\//;
	if (dirRe.test(normalized)) return true;

	// Bundled / minified asset filenames. These are generated artifacts;
	// scanning them is pure noise.
	if (/\.min\.(?:js|css|mjs|cjs)$/.test(normalized)) return true;
	if (/\.bundle\.(?:js|css|mjs|cjs)$/.test(normalized)) return true;

	return false;
}

/**
 * Check if a file is a CLI entry point or command file.
 * These files use console.log as their primary output method.
 * Path-agnostic: works for any project structure.
 */
export function isCliFile(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	// CLI command directories (convention across many frameworks)
	if (normalized.includes("/commands/")) return true;
	if (normalized.includes("/cmd/")) return true;
	// Bin directories
	if (normalized.includes("/bin/")) return true;
	// Entry points named index/main/cli in typical CLI locations
	const basename = normalized.split("/").pop() || "";
	if (/^(main|cli|index)\.(ts|js|mjs|py|go|rs)$/.test(basename)) {
		// Only skip if it's in a recognizable CLI/bin/src root — not deeply nested library code
		if (
			normalized.includes("/cli/") ||
			normalized.includes("/bin/") ||
			normalized.includes("/cmd/") ||
			// Top-level entry points (e.g., src/main.ts, src/index.ts)
			/\/src\/[^/]+$/.test(normalized)
		) {
			return true;
		}
	}
	return false;
}

/**
 * Detect generator-output files by looking for tooling markers in the
 * first 20 lines. Generators routinely emit code that uses `any`,
 * file-level lint suppression headers, and `.test.<ext>` siblings that
 * don't exist — flagging that surface is pure noise (the fix is to
 * change the generator config, not the file).
 *
 * Origin: 139-repo FP audit. Supermodel's `sdk/src/apis/DefaultApi.ts`
 * (auto-generated by OpenAPI Generator) produced ~555 FPs in one file —
 * 290 strong_typing + 132 file_level_suppression + 67 files_without_test +
 * 66 suppressions — none real. Header includes:
 *   `NOTE: This class is auto generated by OpenAPI Generator`
 *
 * Bounded scan (first 20 lines) so a file with `// auto-generated`
 * mentioned in some deep doc-block doesn't accidentally exempt itself.
 * The marker has to be near the top — the standard generator convention.
 */
const GENERATOR_MARKERS: readonly string[] = [
	"auto generated",
	"auto-generated",
	"automatically generated",
	"openapi generator",
	"openapi-generator",
	"swagger-codegen",
	"do not edit by hand",
	"do not edit",
	"this file was generated",
	"code generated by protoc",
	"@generated",
];

export function isGeneratedFile(content: string): boolean {
	// Bounded scan: first 20 lines, lower-cased once. Linear over a small
	// window — cheaper than firing the suppressed checks downstream.
	const head = content.split("\n", 20).join("\n").toLowerCase();
	return GENERATOR_MARKERS.some((m) => head.includes(m));
}

/**
 * Detect a TypeScript module whose entire surface is type-level — only
 * `interface` / `type` declarations (plus imports and type re-exports),
 * with no runtime code. Such a module emits nothing executable; `tsc`
 * already validates it, so checks that demand a `.test.<ext>` sibling
 * (`no_test_file`, the TDD-cycle nudges) only ever false-positive on it.
 * The harness's own `src/harness/types/*.ts` were the recurring trigger.
 *
 * TS-only by extension: `interface` / `type` are not reliable type-only
 * markers in Go (`type X struct`) or JS, so non-TS files return false.
 *
 * Conservative — any top-level runtime declaration, import/export, or
 * expression statement marks the module NOT type-only. A file with even one
 * runtime value is still checked; the failure mode is "check a file that
 * needn't be tested", never "skip a real one".
 */
export function isTypeOnlyModule(filePath: string, content: string): boolean {
	if (!/\.(?:ts|tsx|mts|cts)$/i.test(filePath)) return false;
	const code = stripCommentsAndStrings(content);
	// Must declare at least one type — otherwise "type-only" is vacuous
	// (an empty file, a pure side-effect import module, etc.).
	if (!/^[ \t]*(?:export[ \t]+)?(?:interface|type)[ \t]/m.test(code)) {
		return false;
	}
	// `export default <expr>` ships a runtime value even with no keyword.
	if (/^[ \t]*export[ \t]+default\b/m.test(code)) return false;
	if (!hasOnlyTypeLevelTopLevelStatements(code)) return false;
	return true;
}

type TypeOnlyTopLevelMode = "import-type" | "type" | "interface";

function hasOnlyTypeLevelTopLevelStatements(code: string): boolean {
	let offset = 0;

	while (true) {
		offset = skipWhitespace(code, offset);
		if (offset >= code.length) return true;

		const mode = typeOnlyTopLevelModeAt(code, offset);
		if (mode === null) return false;

		const nextOffset = findTypeOnlyStatementEnd(code, offset, mode);
		if (nextOffset === null || nextOffset <= offset) return false;
		offset = nextOffset;
	}
}

function skipWhitespace(code: string, offset: number): number {
	let i = offset;
	while (i < code.length && /\s/.test(code[i] ?? "")) i++;
	return i;
}

function typeOnlyTopLevelModeAt(code: string, offset: number): TypeOnlyTopLevelMode | null {
	const rest = code.slice(offset);
	if (/^import[ \t]+type\b/.test(rest)) return "import-type";
	if (/^(?:export[ \t]+)?type\b/.test(rest)) return "type";
	if (/^(?:export[ \t]+)?interface\b/.test(rest)) return "interface";
	return null;
}

/** Mutable bracket-nesting bookkeeping for a single top-level statement scan.
 *  `interfaceSawBody` records whether the interface's `{ … }` body has opened
 *  yet — used to distinguish `interface X {}` completion from a stray brace. */
interface TypeOnlyScanState {
	braceDepth: number;
	bracketDepth: number;
	parenDepth: number;
	interfaceSawBody: boolean;
}

/** True when no bracket/brace/paren is currently open — i.e. we're back at the
 *  statement's top level and a `;` or newline can legitimately terminate it. */
function atTopLevelDepth(state: TypeOnlyScanState): boolean {
	return state.braceDepth === 0 && state.bracketDepth === 0 && state.parenDepth === 0;
}

/** Advance the nesting depths for a single bracket-class character. Non-bracket
 *  characters leave the state untouched. For `interface` mode, opening the first
 *  `{` flips `interfaceSawBody` so the matching close can be recognized. */
function updateTypeOnlyScanDepth(
	state: TypeOnlyScanState,
	ch: string | undefined,
	mode: TypeOnlyTopLevelMode,
): void {
	if (ch === "{") {
		state.braceDepth++;
		if (mode === "interface") state.interfaceSawBody = true;
	} else if (ch === "}") {
		state.braceDepth = Math.max(0, state.braceDepth - 1);
	} else if (ch === "[") {
		state.bracketDepth++;
	} else if (ch === "]") {
		state.bracketDepth = Math.max(0, state.bracketDepth - 1);
	} else if (ch === "(") {
		state.parenDepth++;
	} else if (ch === ")") {
		state.parenDepth = Math.max(0, state.parenDepth - 1);
	}
}

/**
 * Decide whether the current character at index `i` ends the type-only
 * statement, returning the index just past the statement (or `null` to keep
 * scanning). Called AFTER `updateTypeOnlyScanDepth` has applied this character's
 * depth change, so an interface's closing `}` is seen at `braceDepth === 0`.
 */
function typeOnlyStatementEndAt(
	code: string,
	i: number,
	ch: string | undefined,
	mode: TypeOnlyTopLevelMode,
	state: TypeOnlyScanState,
): number | null {
	if (ch === "}" && mode === "interface" && state.interfaceSawBody && state.braceDepth === 0) {
		return consumeOptionalSemicolon(code, i + 1);
	}
	if (ch === ";" && atTopLevelDepth(state)) {
		return i + 1;
	}
	if (
		ch === "\n" &&
		mode !== "interface" &&
		atTopLevelDepth(state) &&
		canEndTypeOnlyStatementAtNewline(code, i, mode)
	) {
		return i + 1;
	}
	return null;
}

function findTypeOnlyStatementEnd(
	code: string,
	offset: number,
	mode: TypeOnlyTopLevelMode,
): number | null {
	const state: TypeOnlyScanState = {
		braceDepth: 0,
		bracketDepth: 0,
		parenDepth: 0,
		interfaceSawBody: false,
	};

	for (let i = offset; i < code.length; i++) {
		const ch = code[i];
		updateTypeOnlyScanDepth(state, ch, mode);
		const end = typeOnlyStatementEndAt(code, i, ch, mode, state);
		if (end !== null) return end;
	}

	if (!atTopLevelDepth(state)) return null;
	if (mode === "interface" && !state.interfaceSawBody) return null;
	return code.length;
}

function consumeOptionalSemicolon(code: string, offset: number): number {
	let i = offset;
	while (i < code.length && (code[i] === " " || code[i] === "\t" || code[i] === "\r")) {
		i++;
	}
	return code[i] === ";" ? i + 1 : offset;
}

function canEndTypeOnlyStatementAtNewline(
	code: string,
	newlineOffset: number,
	mode: TypeOnlyTopLevelMode,
): boolean {
	const nextLineStart = newlineOffset + 1;
	const nextLineEnd = code.indexOf("\n", nextLineStart);
	const nextLine =
		nextLineEnd === -1
			? code.slice(nextLineStart).trim()
			: code.slice(nextLineStart, nextLineEnd).trim();
	if (nextLine.length === 0) return true;
	if (mode === "import-type") return !/^from\b/.test(nextLine);
	return !(
		/^[|&=?:,\]>)]/.test(nextLine) ||
		/^(?:keyof|readonly|infer|typeof|unique|this)\b/.test(nextLine)
	);
}

/**
 * Detect script/CLI/tool/tutorial paths where `print()` and
 * `console.log()` are the legitimate output channel — not a debug
 * leak. Used to suppress `ubs_print_debug_leak` and `console_debug` on
 * files where stdout is the product.
 *
 * Origin: 139-repo FP audit. mcpbr's `scripts/sync_version.py` had 194
 * print() hits — all CLI output, all FP. Supermodel's
 * `cli/internal/setup/wizard.go` had 13 fmt.Println — interactive setup
 * wizard, also FP. The path-segment match is OR'd with `tutorial[s]/`
 * because tutorial fixtures intentionally print example output.
 *
 * Path segments anchored by leading slash or string-start so a directory
 * named `myscripts` (no slash boundary before `scripts`) does NOT match.
 * The regex form mirrors `isVendoredOrFixturePath`'s anchoring contract.
 */
export function isScriptOrCliPath(filePath: string): boolean {
	const norm = filePath.replace(/\\/g, "/");
	// `scripts/`, `script/`, `bin/`, `cli/`, `tools/`, `tool/`, `tutorial/`,
	// `tutorials/`, `examples/`, `example/`, `demos/`, `demo/`, `samples/`,
	// `sample/` as a path segment — anchored start-of-string OR slash.
	// `examples/` added 2026-05 after Helicone audit found 99 console.log
	// FPs in `ai-sdk-provider/examples/*.ts` — example code is print-by-design.
	return (
		/(^|\/)(?:scripts?|bin|cli|tools?)\//.test(norm) ||
		/(^|\/)tutorials?\//.test(norm) ||
		/(^|\/)examples?\//.test(norm) ||
		/(^|\/)demos?\//.test(norm) ||
		/(^|\/)samples?\//.test(norm)
	);
}

/**
 * Bandit/eslint suppression-comment respect — when an author has
 * explicitly acknowledged a finding via `# noqa: <code>` (Python /
 * Bandit) or equivalent, the harness should not double-fire. Maps the
 * Bandit code namespace to our internal check ids.
 *
 * Origin: 139-repo FP audit. Supermodel's `mcpbr/src/mcpbr/tutorial.py`
 * contained `subprocess.run(  # noqa: S602 -- tutorial validation runs
 * user-defined shell commands by design, ...)` — explicit, reasoned,
 * intentional. `custom_metrics.py:347` had `value = float(eval(
 * metric_def.compute_fn, {"__builtins__": {}}, ns))  # noqa: S307` —
 * sandboxed eval, suppression carries the intent.
 *
 * The mapping is conservative: codes with no equivalent in our
 * registry (S311 `random`-for-security) map to `[]` and never
 * suppress. Bare `# noqa` (no code) is treated as suppress-everything
 * per Python convention — same as flake8's behavior.
 */
const BANDIT_TO_CHECK_ID: Record<string, readonly string[]> = {
	S102: ["ubs_eval_input_tainted"], // exec
	S301: ["ubs_pickle_untrusted_load"], // pickle
	S307: ["ubs_eval_input_tainted"], // eval
	S310: ["ubs_unchecked_redirect"], // urllib.request urlopen
	S311: [], // random for security — no equivalent in registry
	S314: ["ubs_xml_external_entity"], // xml ElementTree
	S320: ["ubs_xml_external_entity"], // lxml.etree
	S324: ["weak_hash"], // weak MD5/SHA1
	S501: ["tls_verify_disabled"], // verify=False
	S602: ["ubs_subprocess_shell_true"], // subprocess shell=True
	S603: ["ubs_subprocess_shell_true"],
	S605: ["child_process_exec_user_input"],
	S608: ["ubs_sql_string_concat"], // SQL injection
};

const NOQA_RE = /#\s*noqa(?::\s*([A-Z]\d+(?:\s*,\s*[A-Z]\d+)*))?/;

export function lineHasNoqaSuppression(line: string, checkId: string): boolean {
	const m = NOQA_RE.exec(line);
	if (!m) return false;
	// Bare `# noqa` suppresses everything (Python/flake8 convention).
	if (!m[1]) return true;
	const codes = m[1].split(/\s*,\s*/);
	return codes.some((code) => BANDIT_TO_CHECK_ID[code]?.includes(checkId));
}

// ===========================================
// Internal Helpers
// ===========================================

/** Extract file extension (lowercase, with dot) */
export function getExtension(filePath: string): string {
	const dot = filePath.lastIndexOf(".");
	if (dot === -1) return "";
	return filePath.slice(dot).toLowerCase();
}

// ===========================================
// Enclosing-scope detection — used to give findings context
// ===========================================
// When a finding fires at a specific line, we want to tell the caller
// *which function/class/method* the line belongs to. This saves the
// agent from re-reading the file just to triage the warning. We avoid
// AST parsing — strip comments/strings, then scan backwards looking
// for the nearest declaration whose body opens before our target line.
// Heuristic only; meant for log annotations, not refactoring.

const SCOPE_DECLARATION_RES: readonly RegExp[] = [
	// `function name(` or `function* name(` or `async function name(`
	/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
	// `class Name` (with optional extends/implements)
	/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/,
	// `const|let|var name = (...) => {` or `... = function (...) {`
	/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
	/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/,
	// Class method: `methodName(args) {` or `async methodName(args) {`
	// Indented (inside a class body). Excludes control keywords.
	/^\s+(?:async\s+|static\s+|public\s+|private\s+|protected\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/,
];

const SCOPE_KEYWORD_BLACKLIST = new Set([
	"if",
	"for",
	"while",
	"switch",
	"catch",
	"return",
	"do",
	"with",
	"throw",
	"typeof",
	"new",
	"in",
	"of",
	"as",
]);

/**
 * Find the name of the nearest enclosing function / arrow / class / method
 * for a 1-based line number. Returns null if the line is at top-level (no
 * enclosing scope) or detection fails.
 *
 * Public API — consumed by `quality-checks.ts` to annotate findings with
 * the enclosing scope so cold readers don't have to open the file just to
 * see "what function is this line in?". Heuristic; tolerant of comments
 * and string literals via `stripCommentsAndStrings` upstream.
 */
export function findEnclosingScope(content: string, line: number): string | null {
	const stripped = stripCommentsAndStrings(content);
	const lines = stripped.split("\n");
	const targetIdx = Math.max(0, Math.min(line - 1, lines.length - 1));

	// Walk backwards looking for the nearest declaration whose `{` opens
	// at or before the target line. We don't try to verify scope-end —
	// reporting the closest enclosing name is good enough for triage.
	for (let i = targetIdx; i >= 0; i--) {
		const candidate = lines[i];
		if (candidate === undefined) continue;
		const name = matchScopeDeclaration(candidate);
		if (name && !SCOPE_KEYWORD_BLACKLIST.has(name)) {
			return name;
		}
	}
	return null;
}

function matchScopeDeclaration(line: string): string | null {
	for (const re of SCOPE_DECLARATION_RES) {
		const m = re.exec(line);
		if (m) return m[1] ?? null;
	}
	return null;
}

// ===========================================
// Comment & String Stripping Helpers (delegated to shared-text-utils.ts)
// ===========================================
export {
	scanLinesStripped,
	stripComments,
	stripCommentsAndStrings,
	stripForBraceScan,
	stripStrings,
} from "./shared-text-utils.js";
