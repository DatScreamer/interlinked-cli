// Agent-safety checks — "Additional correctness / style" (part 2 of 2).
// Extracted from agent-safety.ts to stay under the 800-line module ceiling.

import { readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { parseExports, parseImports, resolveImportPath } from "../project-graph.js";
import { getGitSourceFiles } from "./export-ripple.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_EXTS,
	stripComments,
	stripCommentsAndStrings,
} from "./shared.js";

// --- 6. Additional correctness/style ---

/**
 * Detect throw of non-Error values: `throw "message"`, `throw 0`, `throw undefined`.
 * Throwing non-Error objects loses stack traces and breaks instanceof Error checks.
 */
export function checkThrowLiteral(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const trimmed = strippedLines[i].trim();
		// throw followed by a string literal, number, boolean, null, undefined, or a variable (not `new`)
		// We check original content for string literals since stripped content removes them
		if (/^\bthrow\s+/.test(trimmed)) {
			const afterThrow = trimmed.replace(/^throw\s+/, "");
			// Skip: throw new Error(...), throw new SomeError(...)
			if (/^new\s+/.test(afterThrow)) continue;
			// Skip: throw someVar (could be an Error instance — too ambiguous)
			// Only flag obvious literals: throw "...", throw 0, throw true, throw null, throw undefined
			const origTrimmed = originalLines[i].trim().replace(/^throw\s+/, "");
			if (
				/^["'`]/.test(origTrimmed) ||
				/^\d+/.test(afterThrow) ||
				/^(true|false|null|undefined)\b/.test(afterThrow)
			) {
				matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
			}
		}
	}
	return matches;
}

/**
 * Detect `export default` declarations that are either anonymous or whose
 * symbol name doesn't match the filename. Default exports are grep-hostile —
 * a cold agent searching for `Foo` misses `export default function Foo`
 * because the symbol name often isn't at the export site and rename tools
 * don't update string references to the default.
 *
 * Flags:
 *   - Anonymous default: `export default function () {}`, `export default () => …`,
 *     `export default {`, `export default [`.
 *   - Named default whose name differs from the filename (case-insensitive).
 *
 * Skips:
 *   - Config files: `vite.config.*`, `vitest.config.*`, `biome.config.*`,
 *     `tsup.config.*`, `tailwind.config.*`, `next.config.*`, `rollup.config.*`,
 *     `webpack.config.*`, `playwright.config.*`. Default export is the framework
 *     contract in each case.
 *   - Test files, `.d.ts`, non-JS/TS extensions.
 */
export function checkDefaultExport(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];
	if (filePath.endsWith(".d.ts")) return [];

	const base = basename(filePath).replace(/\.(tsx?|jsx?|mjs|cjs|mts|cts)$/, "");
	if (
		/^(vite|vitest|biome|tsup|tailwind|next|rollup|webpack|playwright|astro|remix|nuxt|svelte|eslint|prettier|cypress|jest)\.config$/i.test(
			base,
		)
	) {
		return [];
	}

	if (isCloudflareWorkerHandler(content)) return [];

	const stripped = stripComments(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	const ANON_FORMS = [
		/^export\s+default\s+function\s*\(/, // function () {
		/^export\s+default\s+async\s+function\s*\(/, // async function () {
		/^export\s+default\s+class(?:\s+extends\s+\S+)?\s*\{/, // class { or class extends X {
		/^export\s+default\s+\(/, // (args) =>  OR (expr)
		/^export\s+default\s+\{/, // object literal
		/^export\s+default\s+\[/, // array literal
	];
	const NAMED_FORM =
		/^export\s+default\s+(?:async\s+)?(?:function\s*\*?\s+|class\s+)?([A-Za-z_$][\w$]*)\s*[\s({]?/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i].trim();
		if (!line.startsWith("export default")) continue;

		// Anonymous forms — always flag.
		if (ANON_FORMS.some((re) => re.test(line))) {
			matches.push({
				line: i + 1,
				text: `anonymous default export: ${originalLines[i]?.trim().slice(0, 120) ?? ""}`,
			});
			continue;
		}

		// Named form — flag when the symbol name doesn't match the filename.
		const named = NAMED_FORM.exec(line);
		if (named) {
			const sym = named[1];
			if (sym.toLowerCase() !== base.toLowerCase()) {
				matches.push({
					line: i + 1,
					text: `default export '${sym}' does not match filename '${base}' — grep-hostile for cold readers`,
				});
			}
		}
	}

	return matches;
}

// Cloudflare Workers handler-shape detection. The runtime dispatches into
// these methods on the default export; renaming the symbol or splitting it
// into named exports breaks the contract. We exempt files that look like
// Worker handler modules from `default_export` flagging.
//
// Detection signals (any one is sufficient):
//   1. `satisfies ExportedHandler<...>` or `: ExportedHandler<...>` —
//      explicit type annotation, highest confidence.
//   2. `export default { ... }` (anonymous object literal) where one of the
//      canonical handler method names appears within ~400 chars of the
//      opening brace (covers method shorthand + property assignment).
//   3. `export default <name>;` paired with `const|let|var <name> = { ... }`
//      whose body contains a canonical handler method name.
const WORKER_HANDLER_METHODS = "fetch|email|queue|scheduled|tail|trace";
const WORKER_HANDLER_TYPE_RE = /(?:satisfies|:)\s*ExportedHandler\b/;
const WORKER_HANDLER_ANON_RE = new RegExp(
	`export\\s+default\\s+\\{[\\s\\S]{0,400}?\\b(?:${WORKER_HANDLER_METHODS})\\s*[(:]`,
);
const WORKER_HANDLER_NAMED_DEFAULT_RE = /export\s+default\s+([A-Za-z_$][\w$]*)\s*;/;

function isCloudflareWorkerHandler(content: string): boolean {
	if (WORKER_HANDLER_TYPE_RE.test(content)) return true;
	if (WORKER_HANDLER_ANON_RE.test(content)) return true;
	const namedMatch = WORKER_HANDLER_NAMED_DEFAULT_RE.exec(content);
	if (namedMatch) {
		const name = namedMatch[1];
		const declRe = new RegExp(
			`(?:const|let|var)\\s+${name}\\s*=\\s*\\{[\\s\\S]{0,400}?\\b(?:${WORKER_HANDLER_METHODS})\\s*[(:]`,
		);
		if (declRe.test(content)) return true;
	}
	return false;
}

/**
 * Detect classes that register subscriptions (addEventListener, setInterval,
 * setTimeout) in one method but don't clean them up in a lifecycle method
 * (`dispose` / `destroy` / `close` / `unmount` / `stop`). The cleanup
 * pair-up is the kind of thing a cold agent easily forgets — adding a
 * subscription feels local to `start()` but the cleanup has to live
 * elsewhere.
 *
 * Heuristic (regex + brace-matching, no AST):
 *   1. Find each `class X { ... }` block. Track braces to find the matching
 *      close.
 *   2. Only consider classes that already declare at least one lifecycle
 *      method — that signals the author thinks in dispose semantics. Classes
 *      without a lifecycle method aren't flagged (we can't claim they "should"
 *      have one).
 *   3. For each subscription primitive present in the class body, check the
 *      lifecycle method body for its paired cleanup:
 *        - `setInterval` → `clearInterval`
 *        - `setTimeout`  → `clearTimeout`
 *        - `addEventListener` → `removeEventListener`
 *   4. Flag the subscription-add line if the pair is missing.
 *
 * Skips test files, non-JS/TS files.
 */
// Forward brace-matcher: scanning `text` from `start` (already one char INSIDE
// an opening brace, so depth begins at 1), return the index just past the
// matching close and whether the braces balanced. Shared by the class-body and
// lifecycle-method body scans in checkLifecycleCleanup.
function matchBraceEnd(text: string, start: number): { end: number; balanced: boolean } {
	let depth = 1;
	let pos = start;
	while (pos < text.length && depth > 0) {
		const ch = text[pos];
		if (ch === "{") depth++;
		else if (ch === "}") depth--;
		pos++;
	}
	return { end: pos, balanced: depth === 0 };
}

// Extract the bodies of any lifecycle methods (dispose/destroy/close/unmount/
// stop) declared in `classBody`. Each returned string is the method body text
// (including its closing brace), used to look for paired cleanup calls.
function collectLifecycleBodies(classBody: string, names: string[]): string[] {
	const bodies: string[] = [];
	for (const name of names) {
		// Method forms: `dispose() {`, `async dispose() {`, `dispose = () => {`.
		const methodRegex = new RegExp(
			`\\b(?:async\\s+|static\\s+|private\\s+|public\\s+|protected\\s+)*${name}\\s*(?:\\([^)]*\\)\\s*(?::[^{]+)?\\s*\\{|=\\s*(?:async\\s+)?\\([^)]*\\)\\s*=>\\s*\\{)`,
			"g",
		);
		for (let mm = methodRegex.exec(classBody); mm !== null; mm = methodRegex.exec(classBody)) {
			const start = mm.index + mm[0].length;
			const { end, balanced } = matchBraceEnd(classBody, start);
			if (balanced) bodies.push(classBody.slice(start, end));
		}
	}
	return bodies;
}

export function checkLifecycleCleanup(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const LIFECYCLE_METHOD_NAMES = ["dispose", "destroy", "close", "unmount", "stop"];
	const PAIRS: Array<{ add: RegExp; clean: RegExp; label: string }> = [
		{ add: /\bsetInterval\s*\(/, clean: /\bclearInterval\s*\(/, label: "setInterval" },
		{ add: /\bsetTimeout\s*\(/, clean: /\bclearTimeout\s*\(/, label: "setTimeout" },
		{
			add: /\baddEventListener\s*\(/,
			clean: /\bremoveEventListener\s*\(/,
			label: "addEventListener",
		},
	];

	// Scan for class blocks. Use the stripped content for matching so we don't
	// trip on keywords inside strings/comments.
	const classRegex = /\bclass\s+[A-Za-z_$][\w$]*(?:\s+extends\s+[^{]+)?\s*\{/g;
	for (
		let classMatch = classRegex.exec(stripped);
		classMatch !== null;
		classMatch = classRegex.exec(stripped)
	) {
		if (matches.length >= 10) break;

		const bodyStart = classMatch.index + classMatch[0].length;
		const { end: bodyEnd, balanced } = matchBraceEnd(stripped, bodyStart);
		if (!balanced) continue; // unbalanced

		const classBody = stripped.slice(bodyStart, bodyEnd);

		// Only warn on classes that already have a lifecycle method — we can't
		// claim every class must have one.
		const lifecycleBodies = collectLifecycleBodies(classBody, LIFECYCLE_METHOD_NAMES);
		if (lifecycleBodies.length === 0) continue;
		const combinedCleanup = lifecycleBodies.join("\n");

		for (const pair of PAIRS) {
			if (matches.length >= 10) break;
			if (!pair.add.test(classBody)) continue;
			if (pair.clean.test(combinedCleanup)) continue;

			// Find the subscription-add line within the class body for reporting.
			const addSearch = pair.add.exec(classBody);
			if (!addSearch) continue;
			const absOffset = bodyStart + addSearch.index;
			const lineIdx = (stripped.slice(0, absOffset).match(/\n/g) || []).length;
			matches.push({
				line: lineIdx + 1,
				text: `${pair.label}() without matching ${pair.clean.source.replace(/\\b|\\s\*\\\(|\//g, "")} in lifecycle method: ${originalLines[lineIdx]?.trim().slice(0, 120) ?? ""}`,
			});
		}
	}

	return matches;
}

/**
 * Detect import cycles involving the edited file. A cycle (A → B → C → A)
 * usually signals unclear module boundaries and can cause runtime
 * undefined-at-import-time bugs that are hard to debug because the symptom
 * (a property access on `undefined`) is far from the cause.
 *
 * Self-contained DFS walk:
 *   - Start from the edited file and follow its non-type-only imports.
 *   - For each file, read content on demand (cached per call), parse imports,
 *     resolve specifiers to absolute paths.
 *   - Flag any path that returns to the starting file.
 *   - Cap depth at `MAX_DEPTH` and output at `MAX_PATHS` to stay fast.
 *
 * Type-only imports are skipped — they're erased at compile time and don't
 * create runtime cycles.
 *
 * Skips test files, `.d.ts` files, non-JS/TS extensions, and files outside
 * the project root.
 */
export function checkCircularImports(
	content: string,
	filePath: string,
	cwd: string,
): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (filePath.endsWith(".d.ts")) return [];

	const absStart = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
	if (relative(cwd, absStart).startsWith("..")) return [];

	const MAX_DEPTH = 10;
	const MAX_PATHS = 5;
	const fileCache = new Map<string, string | null>();
	const readCached = (p: string): string | null => {
		const hit = fileCache.get(p);
		if (hit !== undefined) return hit;
		try {
			const raw = readFileSync(p, "utf-8");
			fileCache.set(p, raw);
			return raw;
		} catch {
			fileCache.set(p, null);
			return null;
		}
	};

	const cycles: string[][] = [];
	const onPath = new Set<string>();

	const dfs = (current: string, trail: string[]): void => {
		if (cycles.length >= MAX_PATHS) return;
		if (trail.length > MAX_DEPTH) return;

		const src = current === absStart && trail.length === 0 ? content : readCached(current);
		if (!src) return;

		const imports = parseImports(src, current);
		for (const edge of imports) {
			if (cycles.length >= MAX_PATHS) return;
			if (edge.isTypeOnly) continue;
			const resolved = resolveImportPath(current, edge.specifier);
			if (!resolved) continue;

			if (resolved === absStart && trail.length > 0) {
				cycles.push([...trail, current, absStart]);
				continue;
			}
			if (onPath.has(resolved)) continue; // Avoid infinite recursion on other cycles.

			onPath.add(resolved);
			dfs(resolved, [...trail, current]);
			onPath.delete(resolved);
		}
	};

	onPath.add(absStart);
	dfs(absStart, []);
	onPath.delete(absStart);

	const matches: InlineMatch[] = [];
	const seen = new Set<string>();
	for (const cycle of cycles) {
		if (matches.length >= 10) break;
		const readable = cycle.map((p) => relative(cwd, p)).join(" → ");
		if (seen.has(readable)) continue;
		seen.add(readable);
		matches.push({ line: 1, text: `import cycle: ${readable}` });
	}
	return matches;
}

/**
 * Detect exports that no other file in the project imports. Cold-reader
 * clarity signal: `export { foo, bar, baz }` promises a public surface —
 * when half of it is actually dead, a cold agent wastes time trying to
 * understand what `bar` is for when it's never used.
 *
 * Strategy (project-wide, reuses getGitSourceFiles + parseExports):
 *   1. Parse the edited file's exports. Filter out re-exports (covered by
 *      checkExportRipple) and type-only exports (often legitimate public API
 *      even when unused internally).
 *   2. For each other source file that references the edited file's basename
 *      in a string literal (cheap prefilter), parse its imports.
 *   3. Aggregate every imported symbol targeted at the edited file.
 *   4. Flag exports whose names don't appear in that aggregate.
 *
 * Early-exits and skips:
 *   - Skip default exports (conservative: default-export hygiene handled by a
 *     separate check).
 *   - Skip barrel files (`index.ts` / `index.tsx`): those are deliberately
 *     wide re-export surfaces; every name is intentionally a public handle.
 *   - Skip test files. Skip `.d.ts` files.
 *   - If any importer uses a namespace import (`import * as X from ...`),
 *     treat ALL exports as used — the namespace reference could be indexing
 *     into any of them at runtime and we can't tell statically.
 */
// Fast basename prefilter for checkDeadExports: does `importerContent` mention
// our module under any import-specifier shape? Covers three shapes:
//   (a) bare module name:           `'hooks'`      / `"hooks"`
//   (b) bare with extension:        `'hooks.js'`   / `"hooks.js"`   / `.ts` variants
//   (c) relative path ending there: `"./lib/hooks.js"`, `"../lib/hooks.js"`, etc.
// Missing any shape silently drops a real importer and marks the symbol as dead.
function importerMentionsModuleBase(importerContent: string, base: string): boolean {
	return (
		importerContent.includes(`'${base}'`) ||
		importerContent.includes(`"${base}"`) ||
		importerContent.includes(`'${base}.js'`) ||
		importerContent.includes(`"${base}.js"`) ||
		importerContent.includes(`'${base}.ts'`) ||
		importerContent.includes(`"${base}.ts"`) ||
		importerContent.includes(`/${base}'`) ||
		importerContent.includes(`/${base}"`) ||
		importerContent.includes(`/${base}.js'`) ||
		importerContent.includes(`/${base}.js"`) ||
		importerContent.includes(`/${base}.ts'`) ||
		importerContent.includes(`/${base}.ts"`)
	);
}

// Walk every candidate importer and aggregate the symbols imported from the file
// at `absPath`. Returns `allUsed: true` when any importer uses a namespace import
// (`import * as X`) — we can't tell statically which exports it touches, so all
// are treated as used.
function collectTargetedImportSymbols(
	candidates: string[],
	cwd: string,
	base: string,
	absPath: string,
): { allUsed: boolean; symbols: Set<string> } {
	const symbols = new Set<string>();
	for (const importerRel of candidates) {
		let importerContent: string;
		try {
			importerContent = readFileSync(join(cwd, importerRel), "utf-8");
		} catch {
			continue;
		}
		if (!importerMentionsModuleBase(importerContent, base)) continue;

		const imports = parseImports(importerContent, join(cwd, importerRel));
		for (const edge of imports) {
			// Resolve the import specifier to see if it points at our file.
			const resolved = resolveImportPath(join(cwd, importerRel), edge.specifier);
			if (!resolved) continue;
			if (resolve(resolved) !== absPath) continue;

			// Namespace import (symbols has "*" or empty with star flag) — treat
			// as "every export is used" and bail out early.
			if (edge.symbols.length === 0 || edge.symbols.includes("*")) {
				return { allUsed: true, symbols };
			}
			for (const s of edge.symbols) symbols.add(s);
		}
	}
	return { allUsed: false, symbols };
}

export function checkDeadExports(content: string, filePath: string, cwd: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(ext)) return [];
	if (filePath.endsWith(".d.ts")) return [];
	if (isTestFile(filePath)) return [];

	const base = basename(filePath).replace(/\.(tsx?|jsx?|mjs|cjs|mts|cts)$/, "");
	if (base === "index") return []; // barrel — intentionally wide

	const exports = parseExports(content).filter(
		(e) =>
			e.kind !== "default" &&
			e.kind !== "re-export" &&
			e.kind !== "namespace" &&
			!e.isTypeOnly,
	);
	if (exports.length === 0) return [];

	const absPath = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
	const relFromRoot = relative(cwd, absPath);
	if (relFromRoot.startsWith("..")) return [];

	// Collect every symbol any other file imports targeting our basename.
	const candidates = getGitSourceFiles(cwd).filter((f) => f !== relFromRoot);
	const { allUsed, symbols: importedSymbols } = collectTargetedImportSymbols(
		candidates,
		cwd,
		base,
		absPath,
	);
	if (allUsed) return [];

	const matches: InlineMatch[] = [];
	for (const exp of exports) {
		if (importedSymbols.has(exp.name)) continue;
		matches.push({
			line: exp.line,
			text: `unused export '${exp.name}' — remove or document as public API`,
		});
		if (matches.length >= 10) break;
	}
	return matches;
}

/**
 * Detect unvalidated JSON.parse / res.json() / req.json() flow — a cold-agent
 * reading `const data = JSON.parse(raw)` followed by `data.someField` has no
 * cue what shape `data` is supposed to have, and no runtime protection if the
 * parsed value doesn't match. This check flags cases where the parsed value
 * reaches property access WITHOUT being piped through a schema parser first.
 *
 * Triggers on:
 *   - `const/let/var <v> = JSON.parse(...)`
 *   - `const/let/var <v> = await <expr>.json()` (fetch/Response/Request body)
 *
 * Resolves as safe if within the next `SCAN_AHEAD` lines `<v>` appears as the
 * argument to `.parse(`, `.safeParse(`, `.decode(`, `.check(`, or
 * `.validate(` — covering zod, valibot, ajv, yup, io-ts, arktype, superstruct,
 * and friends.
 *
 * Flags as unsafe if `<v>.<field>` appears before any validation call.
 * Otherwise (value returned, passed to a function, etc.) we can't tell — skip
 * to keep the FP rate near zero.
 *
 * Skips test files and non-JS/TS files.
 */
export function checkUnvalidatedJsonBoundary(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const SCAN_AHEAD = 15;

	// Assignment form: `const/let/var <v> = (await )?(JSON.parse|<ident>.json)(`.
	const ASSIGN =
		/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?\s*=\s*(?:await\s+)?(?:JSON\.parse|[\w.]+\.json)\s*\(/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i];

		const m = ASSIGN.exec(line);
		if (!m) continue;
		const varName = m[1];

		// Regex escape via alternation: varName is an identifier, safe.
		const propAccess = new RegExp(`\\b${varName}\\.[A-Za-z_$]`);
		const validated = new RegExp(
			`\\.(?:parse|safeParse|decode|check|validate)\\s*\\(\\s*${varName}\\b`,
		);

		let flag = false;
		for (let j = i + 1; j < Math.min(strippedLines.length, i + 1 + SCAN_AHEAD); j++) {
			const forward = strippedLines[j];
			if (validated.test(forward)) {
				flag = false;
				break;
			}
			if (propAccess.test(forward)) {
				flag = true;
				break;
			}
		}

		if (flag) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
		}
	}
	return matches;
}

/**
 * Detect `Promise.reject(<literal>)` — rejecting with a non-Error value.
 * Same failure mode as `throw "string"`: breaks `instanceof Error`, drops
 * the stack trace, and forces downstream catchers to `typeof`-narrow instead
 * of using structured error types.
 *
 * Conservative regex: only `Promise.reject(<literal>)` on one line. Does NOT
 * flag `reject("...")` inside a `new Promise((resolve, reject) => ...)`
 * executor body because plain `reject` is a parameter name and the detection
 * would FP on any executor rebound to a same-named variable.
 */
export function checkPromiseRejectNonError(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripComments(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// `Promise.reject(` followed by a literal we recognize as non-Error.
	// Literals: string (', ", or `), number, true/false/null/undefined.
	const NON_ERROR_ARG = /Promise\.reject\s*\(\s*(?:["'`]|-?\d|true\b|false\b|null\b|undefined\b)/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		if (NON_ERROR_ARG.test(strippedLines[i])) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
		}
	}
	return matches;
}

// checkTemplateCurlyInString and checkSelfCompare were removed — regex-based detection
// has too many false positives (embedded shell scripts, property access chains).
// These are better caught by oxlint with AST analysis (no-template-curly-in-string, no-self-compare).

/**
 * Detect async functions that never use await.
 * The async keyword is unnecessary and misleading — it wraps the return in a Promise for no reason.
 */
// Brace-track from line `start` (which opens a block somewhere on/after it) to
// the line that closes it. Returns `bodyStarted: false` when no `{` was ever
// seen; `bodyEnd` is the line index of the closing brace (or the last line).
function findBlockEndByBrace(
	lines: string[],
	start: number,
): { bodyStarted: boolean; bodyEnd: number } {
	let braceDepth = 0;
	let bodyStarted = false;
	let bodyEnd = start;
	for (let j = start; j < lines.length; j++) {
		for (const ch of lines[j]) {
			if (ch === "{") {
				braceDepth++;
				bodyStarted = true;
			}
			if (ch === "}") braceDepth--;
		}
		if (bodyStarted && braceDepth <= 0) {
			bodyEnd = j;
			break;
		}
	}
	return { bodyStarted, bodyEnd };
}

// Decide whether an async function body is "fine as async" — i.e. should NOT be
// flagged by checkRequireAwait. True when it awaits, is short enough to be a
// trivial wrapper, or references promise machinery (.then/.catch/.finally,
// Promise, or a short delegating `return fn(...)`).
function asyncBodyIsAcceptable(
	bodyText: string,
	originalBodyText: string,
	bodyLen: number,
): boolean {
	// Search both stripped and original body text for await — stripping can
	// sometimes remove await inside template literals or complex expressions.
	if (/\bawait\b/.test(bodyText) || /\bawait\b/.test(originalBodyText)) return true;
	// Short functions (≤5 lines) — likely just wrapping/delegating.
	if (bodyLen <= 5) return true;
	// Bodies that reference promise-related patterns.
	if (/\.(then|catch|finally)\s*\(/.test(bodyText)) return true;
	if (/\bPromise\b/.test(bodyText) || /\bPromise\b/.test(originalBodyText)) return true;
	if (/\breturn\s+\w+\s*\(/.test(bodyText) && bodyLen <= 10) return true;
	return false;
}

export function checkRequireAwait(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const strippedLines = stripped.split("\n");
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];
	// Skip MCP tool handlers — async is required by the McpServer callback interface.
	const norm = filePath.replace(/\\/g, "/");
	if (/\bservers?\b/.test(norm) || /\bscripts?\b/.test(norm)) return [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const trimmed = strippedLines[i].trim();

		// Match async function declarations (not arrow functions — those are harder to scope)
		if (!/\basync\s+function\b/.test(trimmed)) continue;

		// Skip Next.js route handlers — must be async by App Router convention
		const fnName = trimmed.match(/\basync\s+function\s+(\w+)/)?.[1] ?? "";
		if (/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(fnName)) continue;

		const { bodyStarted, bodyEnd } = findBlockEndByBrace(strippedLines, i);
		if (!bodyStarted) continue;

		const bodyText = strippedLines.slice(i, bodyEnd + 1).join("\n");
		const originalBodyText = originalLines.slice(i, bodyEnd + 1).join("\n");
		if (asyncBodyIsAcceptable(bodyText, originalBodyText, bodyEnd - i)) continue;
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}

/**
 * Detect accumulating spread in reduce: arr.reduce((acc, x) => ({...acc, [x]: 1}), {}).
 * This is O(n^2) because each iteration creates a full copy. Use Object.fromEntries or a loop.
 */
export function checkAccumulatingSpread(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const trimmed = strippedLines[i].trim();
		// Pattern: .reduce( ... { ...acc  or  .reduce( ... [...acc
		if (/\.reduce\s*\(/.test(trimmed)) {
			// Look at this line and the next few for spread of accumulator
			const window = strippedLines.slice(i, Math.min(i + 5, strippedLines.length)).join(" ");
			// Skip an optional arrow-fn parameter list `(acc, x) =>` between
			// `.reduce(` and the spread. Without it, the `)` closing the param
			// list stops `[^)]*` and the canonical accumulating form
			// `reduce((acc, x) => [...acc, x], [])` is missed.
			if (/\.reduce\s*\((?:\s*\([^)]*\)\s*=>)?[^)]*[\[{]\s*\.\.\./.test(window)) {
				matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
			}
		}
	}
	return matches;
}

/**
 * Detect a run of 5+ consecutive field copies `target.k = source.k` — same
 * property name on both sides, same target + source objects. Hand-copying one
 * object's fields onto another is fragile: a field later added to the source
 * is silently skipped at the copy site. This is the bug class behind a builder
 * that computes a field its caller forgets to forward.
 */
export function checkManualFieldCopy(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];
	const strippedLines = stripCommentsAndStrings(content).split("\n");
	const matches: InlineMatch[] = [];
	// A field copy is `<obj>.<key> = <obj>.<key>` ending the statement (after
	// an optional `if (...)` guard). Captures target obj/key + source obj/key.
	const copyRe =
		/([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*;?\s*$/;
	let runTarget = "";
	let runSource = "";
	let runCount = 0;
	let runStart = 0;
	const flushRun = () => {
		if (runCount >= 5 && matches.length < 10) {
			matches.push({
				line: runStart,
				text:
					`${runCount} consecutive field copies ${runTarget}.x = ${runSource}.x` +
					` — a field added to ${runSource} is silently skipped here`,
			});
		}
		runCount = 0;
	};
	for (let i = 0; i < strippedLines.length; i++) {
		const trimmed = strippedLines[i].trim();
		if (trimmed === "") continue; // blank / comment-only — does not break a run
		const m = trimmed.match(copyRe);
		const isCopy = m !== null && m[2] === m[4] && m[1] !== m[3];
		if (isCopy && m) {
			if (runCount > 0 && m[1] === runTarget && m[3] === runSource) {
				runCount++;
			} else {
				flushRun();
				runTarget = m[1];
				runSource = m[3];
				runStart = i + 1;
				runCount = 1;
			}
		} else {
			flushRun();
		}
	}
	flushRun();
	return matches;
}
