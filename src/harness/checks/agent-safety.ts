// Agent Safety Checks — Async, Imports, Types, Security, Correctness.
// Deterministic regex/heuristic checks targeting common AI agent mistakes.
// Extracted from generic-checks.ts.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import { stripTemplateLiterals } from "../strip-helpers.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_EXTS,
	scanLinesStripped,
	stripComments,
	stripCommentsAndStrings,
} from "./shared.js";

// ===========================================
// Agent Safety Checks — Async, Imports, Types, Security, Correctness
// ===========================================
// Deterministic regex/heuristic checks targeting common AI agent mistakes.
// Each returns InlineMatch[]. <5ms per check, no external dependencies.

// --- 1. Async/Promise Safety ---

/**
 * Detect no-misused-promises: passing an async function where a synchronous
 * callback is expected (e.g., Array.forEach, Array.map with async but no await on result).
 */
export function checkMisusedPromises(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const trimmed = strippedLines[i].trim();
		// .forEach(async, .map(async without assignment, .filter(async, .some(async, .every(async
		if (/\.(forEach|reduce)\s*\(\s*async\b/.test(trimmed)) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
		}
	}
	return matches;
}

/**
 * Detect floating promises: calls to async-declared functions (or known promise-
 * returning globals like fetch) at statement position without await, return,
 * void, yield, throw, assignment, or a trailing .catch()/.finally() handler.
 *
 * Unhandled rejections from floating promises produce silent failures and
 * `unhandledRejection` warnings in Node. For cold agents reading the code, a
 * bare `foo()` statement gives no signal that `foo` is async — missing the
 * await is an extremely common mistake.
 *
 * Strategy (regex, no type info):
 *   1. Collect identifiers declared `async` in this file — functions, arrow
 *      assignments, class methods, object shorthand.
 *   2. Scan statement-position lines for bare calls to those identifiers (or
 *      to the built-in `fetch`) that lack a handling prefix and don't end with
 *      `.catch(…)`/`.finally(…)` on the same line.
 *   3. Skip lines that are inside an argument list / array literal (previous
 *      non-blank line ends with `(`, `[`, `{`, or `,`) and lines that belong to
 *      a multi-line chain (next non-blank line starts with `.`). Under-detect
 *      rather than FP.
 *
 * Only flags calls we KNOW return a promise (async-declared in-file + small
 * built-in allowlist). Unknown third-party calls are skipped — that's a
 * type-info problem, not a regex problem.
 */
export function checkFloatingPromises(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");

	// Pass 1: collect async identifiers declared in this file.
	const asyncIds = new Set<string>();
	for (const line of strippedLines) {
		// `async function foo(` / `async function *foo(`
		let m = line.match(/\basync\s+function\s*\*?\s+([A-Za-z_$][\w$]*)\s*\(/);
		if (m) asyncIds.add(m[1]);
		// `const foo = async (`, `let foo: Type = async <T>(`, etc.
		m = line.match(
			/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?\s*=\s*async\s*[(<]/,
		);
		if (m) asyncIds.add(m[1]);
		// Class method: `  async foo(` with optional access modifiers / static.
		m = line.match(
			/^\s+(?:(?:public|private|protected|static|readonly|override|abstract)\s+)*async\s+([A-Za-z_$][\w$]*)\s*[(<]/,
		);
		if (m && m[1] !== "function") asyncIds.add(m[1]);
		// Object shorthand property: `foo: async (`.
		m = line.match(/\b([A-Za-z_$][\w$]*)\s*:\s*async\s*[(<]/);
		if (m) asyncIds.add(m[1]);
	}

	// Always-async built-ins commonly forgotten at statement position.
	const BUILTIN_ASYNC_IDS = new Set(["fetch"]);

	// Keywords that, when they lead a statement, consume or redirect the value
	// so the promise cannot be floating.
	const STATEMENT_PREFIX_KEYWORDS =
		/^(?:await|return|yield|void|throw|if|else|for|while|switch|case|default|try|catch|finally|do|break|continue|class|function|const|let|var|export|import|type|interface|enum|new|typeof|delete|async)\b/;

	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i];
		const trimmed = line.trim();
		if (!trimmed) continue;

		// Must start with an identifier; rules out `})`, `.then(...)` chain
		// continuation, `}` block closes, etc.
		if (!/^[A-Za-z_$]/.test(trimmed)) continue;
		if (STATEMENT_PREFIX_KEYWORDS.test(trimmed)) continue;

		// Skip if previous non-blank line indicates we're inside an argument
		// list or array literal — then our "statement-position" assumption is
		// wrong. We deliberately DO NOT include `{` here: a trailing `{` is
		// much more often a block opener (function/class/if/etc.) than a
		// multi-line object literal, and treating blocks as arg lists would
		// swallow every statement that follows a brace.
		let prev = i - 1;
		while (prev >= 0 && strippedLines[prev].trim() === "") prev--;
		if (prev >= 0 && /[([,]\s*$/.test(strippedLines[prev])) continue;

		// Skip arrow-function concise-body return values. When the previous
		// non-blank line ends with `=>`, this line is the single-expression
		// body of an arrow function — its value is *returned*, not dropped.
		// Example false-positive: `discovered.map((d) =>\n    probeHealth(d))`
		if (prev >= 0 && /=>\s*$/.test(strippedLines[prev])) continue;

		// Skip TypeScript interface / type method signatures. A line like
		// `drain(timeoutMs?: number): Promise<void>;` inside an `interface`
		// body syntactically looks like a call but is a DECLARATION — it
		// doesn't execute at runtime. Giveaway: trailing `: Promise<…>;` or
		// `: AsyncIterable<…>;`, AND either a `?:` parameter marker or a
		// trailing semicolon after the type annotation.
		if (
			/\)\s*:\s*(?:Promise|AsyncIterable|AsyncGenerator|AsyncIterator)\s*<[^>]*>\s*;\s*$/.test(
				trimmed,
			)
		)
			continue;

		// Skip multi-line chain bodies: if next non-blank line starts with `.`,
		// the chain's handler (if any) lives on a later line and we can't tell
		// with regex. Under-detect by skipping.
		let next = i + 1;
		while (next < strippedLines.length && strippedLines[next].trim() === "") next++;
		if (next < strippedLines.length && strippedLines[next].trim().startsWith(".")) continue;

		// Capture the leading call path: identifier, dotted, optional-chain,
		// or bracketed, up to the opening paren.
		const callMatch = trimmed.match(/^([\w$?.[\]]+)\s*\(/);
		if (!callMatch) continue;
		const callPath = callMatch[1];

		// Leaf identifier for async-id lookup.
		const leafId = callPath
			.replace(/\?\./g, ".")
			.split(".")
			.pop()
			?.replace(/\[.*\]/g, "");
		if (!leafId) continue;

		const isKnownAsync = asyncIds.has(leafId) || BUILTIN_ASYNC_IDS.has(leafId);
		if (!isKnownAsync) continue;

		// Already-handled chain: `.catch(` or `.finally(` anywhere on this line.
		if (/\.catch\s*\(/.test(trimmed)) continue;
		if (/\.finally\s*\(/.test(trimmed)) continue;

		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}

	return matches;
}

/**
 * Detect no-async-promise-executor: new Promise(async (resolve, reject) => { ... })
 * This is always a bug — the executor should not be async.
 */
export function checkAsyncPromiseExecutor(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /new\s+Promise\s*\(\s*async\b/, 10);
}

// --- 2. Import Hygiene ---

/**
 * Detect self-imports: a module importing from itself (causes infinite loops or empty values).
 */
export function checkSelfImport(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// Get the base filename without extension for matching
	const base = basename(filePath).replace(/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/, "");

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 5) break;
		const trimmed = strippedLines[i].trim();
		if (!/^import\s/.test(trimmed)) continue;
		// Match: from "./same-file" or from "./same-file.js"
		const fromMatch = trimmed.match(/from\s+['"]([^'"]+)['"]/);
		if (!fromMatch) continue;
		const specifier = fromMatch[1];
		if (!specifier.startsWith(".")) continue;
		const importBase = specifier
			.split("/")
			.pop()
			?.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
		if (importBase === base) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
		}
	}
	return matches;
}

/**
 * Detect extraneous dependencies: bare-specifier imports not found in package.json.
 * Requires reading package.json once (cached per filePath directory).
 */
const _pkgDepsCache = new Map<string, Set<string>>();

export function checkExtraneousDependencies(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	// Find nearest package.json
	let pkgDir = dirname(filePath);
	let pkgDeps: Set<string> | undefined;
	for (let i = 0; i < 5; i++) {
		const cached = _pkgDepsCache.get(pkgDir);
		if (cached) {
			pkgDeps = cached;
			break;
		}
		const pkgPath = join(pkgDir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
				const deps = new Set<string>([
					...Object.keys(pkg.dependencies || {}),
					...Object.keys(pkg.devDependencies || {}),
					...Object.keys(pkg.peerDependencies || {}),
					...Object.keys(pkg.optionalDependencies || {}),
				]);
				// Add Node.js built-in modules
				for (const mod of [
					"fs",
					"path",
					"os",
					"url",
					"http",
					"https",
					"crypto",
					"util",
					"stream",
					"events",
					"child_process",
					"net",
					"tls",
					"dns",
					"assert",
					"buffer",
					"querystring",
					"zlib",
					"readline",
					"cluster",
					"worker_threads",
					"perf_hooks",
					"async_hooks",
					"v8",
					"vm",
					"tty",
					"dgram",
					"inspector",
					"trace_events",
					"string_decoder",
					"module",
					"process",
					"timers",
					"console",
				]) {
					deps.add(mod);
					deps.add(`node:${mod}`);
				}
				_pkgDepsCache.set(pkgDir, deps);
				pkgDeps = deps;
				break;
			} catch {
				break;
			}
		}
		const parent = dirname(pkgDir);
		if (parent === pkgDir) break;
		pkgDir = parent;
	}
	if (!pkgDeps) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const trimmed = strippedLines[i].trim();
		if (!/^import\s/.test(trimmed) && !/\brequire\s*\(/.test(trimmed)) continue;

		const fromMatch = trimmed.match(/(?:from\s+|require\s*\(\s*)['"]([^'"]+)['"]/);
		if (!fromMatch) continue;
		const specifier = fromMatch[1];

		// Skip relative imports, aliases (@/), and runtime protocol imports
		if (specifier.startsWith(".") || specifier.startsWith("@/") || specifier.startsWith("#"))
			continue;
		// node:, cloudflare:, bun:, deno: are runtime built-in protocols — never in package.json
		if (/^(node|cloudflare|bun|deno):/.test(specifier)) continue;

		// Extract package name (handle scoped packages @org/pkg)
		const pkgName = specifier.startsWith("@")
			? specifier.split("/").slice(0, 2).join("/")
			: specifier.split("/")[0];

		if (!pkgDeps.has(pkgName)) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
		}
	}
	return matches;
}

// --- 2b. Phantom Dependency Detection (Supply Chain) ---

/**
 * Detect phantom dependencies: packages listed in `dependencies` but never
 * imported/required by any source file in the project. A key indicator of
 * supply chain attacks — e.g., the axios@1.14.1 compromise added
 * 'plain-crypto-js' as a phantom dependency whose sole purpose was running
 * a malicious postinstall script.
 *
 * Only checks `dependencies` (not devDependencies, which are often CLI tools).
 * Skips @types/* packages and known non-imported patterns.
 */
export function checkPhantomDependencies(pkgJsonPath: string): InlineMatch[] {
	if (!existsSync(pkgJsonPath)) return [];

	let content: string;
	let pkg: JsonObject;
	try {
		content = readFileSync(pkgJsonPath, "utf-8");
		pkg = JSON.parse(content);
	} catch {
		return [];
	}

	const deps = pkg.dependencies as Record<string, string> | undefined;
	if (!deps || typeof deps !== "object") return [];

	const depNames = Object.keys(deps);
	if (depNames.length === 0) return [];

	const projectDir = dirname(pkgJsonPath);
	const matches: InlineMatch[] = [];
	const lines = content.split("\n");

	for (const dep of depNames) {
		if (matches.length >= 10) break;

		// Skip @types/* (type-only, never imported at runtime)
		if (dep.startsWith("@types/")) continue;

		if (!_isDepReferencedInProject(dep, projectDir)) {
			const lineIdx = lines.findIndex((l) => l.includes(`"${dep}"`));
			matches.push({
				line: lineIdx >= 0 ? lineIdx + 1 : 1,
				text: `Phantom dependency: "${dep}" is in dependencies but never referenced in project source. Supply chain risk — dependencies should be imported somewhere.`,
			});
		}
	}

	return matches;
}

/**
 * Check if a dependency name appears anywhere in the project's source files
 * (excluding node_modules, lock files, and package.json itself).
 * Uses grep -rqI for fast short-circuit search.
 */
function _isDepReferencedInProject(depName: string, projectDir: string): boolean {
	try {
		execFileSync(
			"grep",
			[
				"-rqI",
				"--exclude-dir=node_modules",
				"--exclude-dir=.git",
				"--exclude-dir=dist",
				"--exclude-dir=build",
				"--exclude-dir=.next",
				"--exclude-dir=coverage",
				"--exclude=package.json",
				"--exclude=package-lock.json",
				"--exclude=yarn.lock",
				"--exclude=pnpm-lock.yaml",
				"--exclude=bun.lockb",
				depName,
				projectDir,
			],
			{ timeout: 5000, stdio: "pipe" },
		);
		return true; // exit 0 = found
	} catch {
		return false; // exit 1 = not found, or timeout
	}
}

// --- 3. Type Safety ---

/**
 * Detect non-null assertions (the `!` operator in TypeScript).
 * Skips test files (tests use `!` for brevity).
 */
export function checkNonNullAssertions(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (ext !== ".ts" && ext !== ".tsx") return [];
	if (isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i];
		// Match identifier! followed by . or [ or ) — but not !== or !=
		if (/\w!\.|\w!\[|\w!\)/.test(line) && !/!==|!=/.test(line.replace(/\w!\./g, ""))) {
			// Verify it's actually a non-null assertion (not a boolean negation)
			const nnaMatch = line.match(/(\w+)!\s*[.[)]/);
			if (nnaMatch) {
				matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
			}
		}
	}
	return matches;
}

/**
 * Detect magic literals used in conditionals without a named constant.
 * Flags: `if (x === <literal>)`, `if (x !== <literal>)`, `switch (x) { case <literal>: }`.
 *
 * A literal is considered "magic" when:
 *   - It is a number > 1 (0 and 1 are common length/index checks, low signal).
 *   - It is a string with length > 2, excluding empty, `"0"`, `"1"`, trivial
 *     tokens like `"true"` / `"false"` / `"null"` / `"undefined"`.
 *
 * The fix-instruction asks the author to extract a named constant or enum —
 * cold readers see `if (status === ORDER_FULFILLED)` and know what branch
 * they're in without jumping anywhere.
 */
export function checkMagicLiteralInConditional(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	// Keep regular-quoted string literals intact — the whole point of this
	// check is to inspect what's INSIDE `=== "..."`. But template-literal
	// bodies are DATA at the call-site level (e.g. the hook template's
	// `\`case "SessionStart": ...\``) and routinely contain generated
	// switch/case scaffolding that isn't a real conditional in THIS file,
	// so we blank them before scanning. Line comments are stripped for the
	// same reason as before — `// if (x === 42)` is documentation, not code.
	const stripped = stripTemplateLiterals(stripComments(content));
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// Comparison literals — number > 1 or string longer than 2 chars excluding
	// trivial values. Capture groups: 1=number, 2=double-quoted, 3=single-quoted.
	const NUM_CMP =
		/(?:===|!==|==|!=)\s*(-?\d+(?:\.\d+)?)(?!\w)|(?:===|!==|==|!=)\s*"([^"\\]{3,})"|(?:===|!==|==|!=)\s*'([^'\\]{3,})'/;
	const CASE_CMP = /^\s*case\s+(?:(-?\d+(?:\.\d+)?)(?!\w)|"([^"\\]{3,})"|'([^'\\]{3,})')\s*:/;

	// Trivial strings that look long enough to match `[^"]{3,}` but shouldn't
	// be flagged: keywords that appear in type comparisons.
	const TRIVIAL_STRINGS = new Set(["true", "false", "null", "undefined"]);

	// Self-describing enum-like identifiers inside `case "X":` labels. The
	// literal IS the name — renaming to `const BASH = "bash"; case BASH:` is
	// pure noise. Matches: single lowercase words, optionally joined by `_`
	// or `-`, no leading digit, e.g. `bash`, `hook_decision`, `kebab-case`.
	// This covers shell names, HTTP methods (after lowercase), log levels,
	// filesystem ops, event kinds, etc. An additional allowlist below catches
	// multi-word/mixed-case values that wouldn't match the heuristic.
	const ENUM_LIKE_CASE_LABEL = /^[a-z][a-z0-9_-]*$/;
	const SELF_DESCRIBING_CASE_ALLOWLIST = new Set([
		// Multi-word or namespaced values that still read as their own name.
		// Single lowercase words already flow through ENUM_LIKE_CASE_LABEL.
		"GET",
		"POST",
		"PUT",
		"DELETE",
		"PATCH",
		"HEAD",
		"OPTIONS",
	]);

	function isMagicNumber(raw: string): boolean {
		const n = Number(raw);
		return Number.isFinite(n) && Math.abs(n) > 1;
	}
	function isMagicString(raw: string): boolean {
		return !TRIVIAL_STRINGS.has(raw);
	}
	// Case-label literals that are self-describing enum-like tokens are
	// skipped — the name is already the value. Applies ONLY in case-label
	// context, not to `if (x === "bash")` where a variable gives context and
	// the literal could still be obscure.
	function isSelfDescribingCaseLabel(raw: string): boolean {
		return ENUM_LIKE_CASE_LABEL.test(raw) || SELF_DESCRIBING_CASE_ALLOWLIST.has(raw);
	}

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i];

		// `if (x === 2)` / `x !== "fulfilled"`
		const eqMatch = NUM_CMP.exec(line);
		if (eqMatch) {
			const [, num, dq, sq] = eqMatch;
			const hit =
				(num !== undefined && isMagicNumber(num)) ||
				(dq !== undefined && isMagicString(dq)) ||
				(sq !== undefined && isMagicString(sq));
			if (hit) {
				matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
				continue;
			}
		}

		// `case 2:` / `case "fulfilled":`
		const caseMatch = CASE_CMP.exec(line);
		if (caseMatch) {
			const [, num, dq, sq] = caseMatch;
			const strLiteral = dq ?? sq;
			// Skip enum-like case labels — they're self-describing.
			if (strLiteral !== undefined && isSelfDescribingCaseLabel(strLiteral)) {
				continue;
			}
			const hit =
				(num !== undefined && isMagicNumber(num)) ||
				(dq !== undefined && isMagicString(dq)) ||
				(sq !== undefined && isMagicString(sq));
			if (hit) {
				matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
			}
		}
	}

	return matches;
}

/**
 * Detect broad/opaque object types that hide shape information from cold
 * readers (including cold agents). Flags:
 *   - `Record<K, any>` / `Record<K, unknown>` — wide mapping with any/unknown.
 *   - `{ [key: string]: any }` / `{ [k: string]: unknown }` index signatures.
 *   - Bare `Function` type annotation (`: Function`, `as Function`).
 *   - Bare `object` type annotation (`: object`, `as object`).
 *
 * Each of these loses enough type information that a reader has to guess the
 * shape. Skips test files (legitimate brevity) and non-TS files.
 */
export function checkBroadObjectTypes(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (ext !== ".ts" && ext !== ".tsx") return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// `Record<…, any>` / `Record<…, unknown>` where the VALUE type is the escape.
	// Accepts any key-type identifier (string, number, symbol, or a branded alias).
	const RECORD_ANY = /\bRecord\s*<\s*[\w.|&\s]+,\s*(?:any|unknown)\s*>/;
	// `{ [k: string]: any }` / `{ [k: string]: unknown }` index signature to any.
	const INDEX_ANY =
		/\{\s*\[\s*\w+\s*:\s*(?:string|number|symbol)\s*\]\s*:\s*(?:any|unknown)\s*\}/;
	// `: Function` or `as Function` — bare Function type.
	const BARE_FUNCTION = /(?::|\bas)\s+Function\b/;
	// `: object` or `as object` — bare object type. Excludes `Object` (the wrapper).
	const BARE_OBJECT = /(?::|\bas)\s+object\b/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i];
		if (
			RECORD_ANY.test(line) ||
			INDEX_ANY.test(line) ||
			BARE_FUNCTION.test(line) ||
			BARE_OBJECT.test(line)
		) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
		}
	}
	return matches;
}

// --- 4. Security ---

/**
 * Detect eval/implied-eval in JavaScript/TypeScript.
 * Catches: eval(), Function(), setTimeout/setInterval with string arg.
 */
export function checkEvalUsage(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const trimmed = strippedLines[i].trim();
		// Direct eval
		if (/\beval\s*\(/.test(trimmed)) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
			continue;
		}
		// new Function() — implied eval
		if (/\bnew\s+Function\s*\(/.test(trimmed)) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
			continue;
		}
		// setTimeout/setInterval with string argument (implied eval)
		if (/\b(setTimeout|setInterval)\s*\(\s*['"`]/.test(trimmed)) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
		}
	}
	return matches;
}

/**
 * Detect dangerouslySetInnerHTML (React) and direct innerHTML assignment.
 * Skips matches inside regex literals and test patterns (e.g., lint check implementations).
 */
export function checkInnerHtmlUsage(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const trimmed = strippedLines[i].trim();
		// Skip lines that are regex patterns (detecting innerHTML vs using it)
		if (/\/.*innerHTML.*\//.test(trimmed) || /\/.*dangerouslySet.*\//.test(trimmed)) continue;
		// Skip lines that are .test() or .match() calls on the pattern
		if (/\.test\(/.test(trimmed) || /\.match\(/.test(trimmed)) continue;
		if (/dangerouslySetInnerHTML/.test(trimmed) || /\.innerHTML\s*=/.test(trimmed)) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
		}
	}
	return matches;
}

// --- 5. Correctness ---

/**
 * Detect NaN comparison: x === NaN, x == NaN, x !== NaN, x != NaN.
 * NaN is never equal to itself. Must use Number.isNaN().
 */
export function checkNanComparison(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /[!=]==?\s*NaN\b|\bNaN\s*[!=]==?/, 10);
}

/**
 * Detect constant conditions: if (true), if (false), while (true) without break,
 * if (0), if (""), if (1).
 */
export function checkConstantCondition(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const trimmed = strippedLines[i].trim();
		// if (true), if (false), if (0), if (1), if ("")
		if (/\bif\s*\(\s*(true|false|0|1|"")\s*\)/.test(trimmed)) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
			continue;
		}
		// Ternary with constant: true ? x : y
		// Exclude comparisons like `=== false ?` or `!== true ?` where the
		// literal is the right-hand side of an operator, not the condition.
		if (/\b(true|false)\s*\?\s*/.test(trimmed) && !/\/\//.test(trimmed)) {
			if (!/[=!<>]\s*(true|false)\s*\?/.test(trimmed)) {
				matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
			}
		}
	}
	return matches;
}

/**
 * Detect unsafe optional chaining: (obj?.foo).bar which throws if obj is nullish.
 * The parenthesized optional chain defeats the purpose of ?. safety.
 * Safe patterns excluded: (x?.foo || fallback).bar, (x?.foo ?? fallback).bar
 */
export function checkUnsafeOptionalChaining(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i];
		// Match (x?.y).z pattern
		if (!/\([^)]*\?\.[^)]*\)\s*\./.test(line)) continue;
		// Exclude safe patterns with fallback operators inside the parens
		// (x?.foo || default).bar and (x?.foo ?? default).bar are safe
		if (/\([^)]*\?\.[^)]*(\|\||&&|\?\?)[^)]*\)\s*\./.test(line)) continue;
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}

/**
 * Detect number precision loss: integer literals > 2^53 - 1 (Number.MAX_SAFE_INTEGER).
 */
export function checkNumberPrecisionLoss(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const MAX_SAFE = 9007199254740991; // 2^53 - 1
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		// Find large integer literals (not BigInt with n suffix)
		const nums = strippedLines[i].match(/\b(\d{16,})\b(?!n)/g);
		if (!nums) continue;
		for (const num of nums) {
			if (Number.parseInt(num, 10) > MAX_SAFE) {
				matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
				break;
			}
		}
	}
	return matches;
}
