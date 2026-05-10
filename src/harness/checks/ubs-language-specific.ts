// UBS (Ultimate Bug Scanner) language-specific detectors — Phase 1 rows 22, 23,
// 25, 29, 30. Each function returns InlineMatch[]. Ext-gated where relevant.

import { stripRegexLiterals } from "../strip-helpers.js";
import {
	getExtension,
	type InlineMatch,
	isScriptOrCliPath,
	isTestFile,
	isVendoredOrFixturePath,
	lineHasNoqaSuppression,
	stripCommentsAndStrings,
} from "./shared.js";

// ===========================================
// Row 22 — `ubs_mutex_lock_unwrap` (Rust)
// ===========================================

/**
 * Detect `Mutex<T>...lock().unwrap()` — panics on poisoned mutex.
 *
 * Plan 04 §4.1 regex: `\bMutex<[^>]+>[\s\S]{0,200}?\.lock\(\)\.unwrap\(\)`.
 * `[^<>]*(?:<[^<>]*>[^<>]*)?` allows one nested generic level so
 * `Mutex<HashMap<String, u64>>` participates. The 200-char window lets the
 * lock and unwrap land on a different line from the declaration.
 */
export function checkMutexLockUnwrap(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".rs") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const re = /\bMutex\s*<[^<>]*(?:<[^<>]*>[^<>]*)?>[\s\S]{0,200}?\.lock\s*\(\s*\)\s*\.unwrap\s*\(\s*\)/g;

	for (const m of stripped.matchAll(re)) {
		if (matches.length >= 10) break;
		// Anchor finding at the `.unwrap` token — the panic site cold readers
		// jump to from the warning.
		const idx = (m.index ?? 0) + m[0].lastIndexOf(".unwrap");
		const lineNum = stripped.slice(0, idx).split("\n").length;
		matches.push({
			line: lineNum,
			text: originalLines[lineNum - 1].trim().slice(0, 150),
		});
	}
	return matches;
}

// ===========================================
// Row 23 — `ubs_subprocess_shell_true` (Python)
// ===========================================

/**
 * Detect `subprocess.<fn>(... shell=True ...)` — command-injection vector.
 *
 * Plan 04 §4.1 regex: `\bsubprocess\.[a-z_]+\s*\([\s\S]{0,500}?\bshell\s*=\s*True\b`.
 * Widened to `[A-Za-z_]+` so `subprocess.Popen(...)` (uppercase entry point)
 * participates — the spec's lowercase form misses Popen, which is the most
 * common subprocess constructor in production code.
 *
 * The 500-char window covers calls split across many keyword-arg lines.
 */
export function checkSubprocessShellTrue(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (ext !== ".py" && ext !== ".pyi") return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const re = /\bsubprocess\.[A-Za-z_]+\s*\([\s\S]{0,500}?\bshell\s*=\s*True\b/g;

	for (const m of stripped.matchAll(re)) {
		if (matches.length >= 10) break;
		// Anchor at `shell` so the warning points at the dangerous keyword.
		const shellIdx = (m.index ?? 0) + m[0].lastIndexOf("shell");
		const lineNum = stripped.slice(0, shellIdx).split("\n").length;
		// 139-repo audit: respect Bandit `# noqa: S602 / S603` on any
		// line within the matched call (the suppression typically sits
		// on the opening line of a multi-line subprocess.run(...)).
		// Scan original lines from the call start to the match end.
		const callStartLine = stripped.slice(0, m.index ?? 0).split("\n").length;
		if (
			isNoqaSuppressedInRange(
				originalLines,
				callStartLine,
				lineNum,
				"ubs_subprocess_shell_true",
			)
		) {
			continue;
		}
		matches.push({
			line: lineNum,
			text: originalLines[lineNum - 1].trim().slice(0, 150),
		});
	}
	return matches;
}

/**
 * Helper: scan a 1-based line range of the original (unstripped) content
 * for a Bandit/flake8-style `# noqa[: <code>]` suppression that maps to
 * the given check id. Used by Python-language checks where the
 * suppression often appears on the opening line of a multi-line call
 * but the match anchors on a deeper keyword (`shell=True`, etc.).
 *
 * Both `startLine` and `endLine` are 1-based and inclusive. Returns
 * true if ANY line in that range carries a suppressing noqa for the
 * given check.
 */
function isNoqaSuppressedInRange(
	originalLines: string[],
	startLine: number,
	endLine: number,
	checkId: string,
): boolean {
	const lo = Math.max(1, Math.min(startLine, endLine));
	const hi = Math.min(originalLines.length, Math.max(startLine, endLine));
	for (let i = lo - 1; i < hi; i++) {
		if (lineHasNoqaSuppression(originalLines[i], checkId)) return true;
	}
	return false;
}

// ===========================================
// Row 25 — `ubs_py_none_equality` (Python)
// ===========================================

/**
 * Detect `x == None` / `x != None` in Python — should be `is None` / `is not None`.
 *
 * Per PEP 8: comparisons to singletons (`None`, `True`, `False`) must use
 * `is`/`is not`, never `==`/`!=`. The latter triggers `__eq__` which can
 * return surprising results for proxy/mock objects.
 *
 * Plan 04 §4.1 regex: `\b\w+\s*[!=]=\s*None\b` (matches `x == None` / `x != None`).
 * Yoda style (`None == x` / `None != x`) is also flagged.
 */
export function checkPyNoneEquality(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (ext !== ".py" && ext !== ".pyi") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// `\b\w+\s*(==|!=)\s*None\b` — identifier ==/!= None. Also covers Yoda.
	// Written as a non-capturing alternation rather than `[!=]=` so the
	// `ubs_js_loose_equality` detector (which lacks regex-literal stripping)
	// doesn't FP on this regex source line.
	const re = /\b\w+\s*(?:==|!=)\s*None\b|\bNone\s*(?:==|!=)\s*\w+/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		if (re.test(strippedLines[i])) {
			matches.push({
				line: i + 1,
				text: originalLines[i].trim().slice(0, 150),
			});
		}
	}
	return matches;
}

/**
 * Row 29: Java `Optional<T>....get()` without an `isPresent()` / `orElse()`
 * guard is a NullPointerException risk. Flagged on `.java` files only.
 *
 * Heuristic: when an `Optional<...>` declaration is followed (within the same
 * file) by a `.get()` call, and there is no `isPresent()` / `orElse(`
 * / `orElseGet(` / `orElseThrow(` / `ifPresent(` referencing the same name in
 * between, surface the `.get()` line. The match scope is per-declaration; a
 * single guard call elsewhere in the file does not exonerate other bare
 * `.get()`s, but a guard on the same name immediately preceding the `.get()`
 * does.
 */
export function checkJavaOptionalGet(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".java") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");

	// Find every `Optional<...> name = ...;` declaration; remember the name.
	// Per Plan 04 §4.3 the regex sketch is `\bOptional<[^>]+>[\s\S]{0,200}?\.get\(\)`.
	// We extract the variable name so the guard-detection step can scope per-name.
	const declRegex = /\bOptional\s*<[^>]+>\s+([A-Za-z_$][\w$]*)\s*=/;
	const optionalNames = new Set<string>();
	for (const line of strippedLines) {
		const m = line.match(declRegex);
		if (m) optionalNames.add(m[1]);
	}
	if (optionalNames.size === 0) return [];

	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i];
		// Find `<name>.get()` references in this line.
		for (const name of optionalNames) {
			const callRe = new RegExp(`\\b${name}\\.get\\s*\\(\\s*\\)`);
			if (!callRe.test(line)) continue;

			// Accept if a guard for this name appears earlier in the file or on
			// the same line.
			const guardRe = new RegExp(
				`\\b${name}\\.(?:isPresent|orElse|orElseGet|orElseThrow|ifPresent|ifPresentOrElse|map|flatMap|filter)\\s*\\(`,
			);
			let guarded = false;
			// Same-line guard wins (e.g. `name.orElse(x)` — fine).
			if (guardRe.test(line.replace(callRe, ""))) {
				guarded = true;
			}
			if (!guarded) {
				for (let j = 0; j < i; j++) {
					if (guardRe.test(strippedLines[j])) {
						guarded = true;
						break;
					}
				}
			}
			if (guarded) continue;

			matches.push({
				line: i + 1,
				text: originalLines[i].trim().slice(0, 150),
			});
			break; // one finding per line is enough
		}
	}
	return matches;
}

/**
 * Row 30: division by a variable identifier — the variable might be zero.
 * Cross-language, advisory by default (high FP rate; ships in
 * DEFAULT_ADVISORY_SKIPS so it only runs under `verify --all-checks`).
 *
 * Both LHS and RHS of the slash must be identifier-shaped, AND the slash
 * must be surrounded by whitespace — i.e. an identifier, one-or-more
 * whitespace chars, slash, one-or-more whitespace chars, identifier.
 * Tightened from a one-sided rule (only the right-hand operand had to be
 * an identifier) after markdown like `value / etc.` and compact prose
 * like `TS/JS-centric` and `if/when` produced false positives. Requiring
 * whitespace blocks the compact-slash cases; requiring an LHS identifier
 * blocks the empty-LHS-after-string-strip case.
 *
 * Bilateral matching loses a few real-code patterns — `arr[i] / b`,
 * `func() / b`, multi-line continuations where the slash starts the
 * line, and compact `a/b` divisions without spaces — which is acceptable
 * since the check is advisory by default and modern style guides format
 * spaces around binary operators.
 *
 * Pure-prose alternation like `regex / AST query / taint pattern` is
 * bilateral-id-shaped and would otherwise fire, so the detector also
 * gates on a source-file extension allow-list (mirroring
 * `checkLargeFunction`'s coverage). Markdown, plain-text, config, and
 * unknown extensions short-circuit before the matcher runs. Extending
 * the allow-list to `.kt` / `.swift` / `.rb` / `.cs` is a one-line edit
 * if a TP is reported there.
 *
 * The detector strips comments and strings first, so `*\/` block-comment
 * terminators, end-of-line comments, and division-looking content inside
 * string literals do not contribute matches.
 */
export function checkDivisionByVariable(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const supported =
		isJsTsFile(ext) ||
		isPyFile(ext) ||
		ext === ".go" ||
		ext === ".java" ||
		ext === ".rs" ||
		ext === ".c" ||
		ext === ".cpp";
	if (!supported) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");

	// 139-repo audit (2026-05): pre-compute a set of names that are
	// ANNOTATED `: Path` or ASSIGNED via `Path(...)` / `pathlib.Path(...)`
	// in the same file. Python's `pathlib.Path.__truediv__` overloads `/`
	// for path joins — `path / "subdir"` is NOT division. The 53 hits in
	// alter/cc-autopipe-source were all of this shape.
	const pathishNames = isPyFile(ext) ? collectPathishNames(stripped) : null;

	const divisionRegex = /(?:^|[^\w$])([a-zA-Z_$]\w*)\s+\/\s+([a-zA-Z_$]\w*)/g;

	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i];
		// Reset lastIndex defensively for the global regex.
		divisionRegex.lastIndex = 0;
		if (!divisionRegex.test(line)) continue;

		// 139-repo audit: skip when a same-line zero-guard is present.
		// Supermodel mcpbr/analytics shape:
		//   avg = total / count if count > 0 else 0.0
		//   rate = (a / b * 100.0) if b > 0 else 0.0
		// The guard sits on the same line via the Python ternary; in JS/Go
		// it appears as `count > 0 ? a / b : 0` or `count !== 0 && a / b`.
		if (lineHasZeroGuard(line)) continue;

		// 139-repo audit: Python `Path / "subdir"` shape — re-run the
		// regex globally to inspect the operands and skip any match
		// whose LHS is annotated/assigned as a Path (or whose
		// neighborhood is a string literal — those are stripped to `""`
		// already, so we look at the original line).
		if (pathishNames && isPathDivisionLine(line, originalLines[i], pathishNames)) {
			continue;
		}

		// 139-repo audit: skip `os.path.join(...)` shapes — even if the
		// regex matched some inner identifier-pair, the call's outer
		// shape is path-join not division.
		if (/\bos\.path\.join\s*\(/.test(line)) continue;

		matches.push({
			line: i + 1,
			text: originalLines[i].trim().slice(0, 150),
		});
	}
	return matches;
}

/**
 * Detect a same-line zero-guard for the divisor. Heuristic — covers the
 * common Python ternary shape (`x / y if y > 0 else 0`), the JS / Go
 * conditional (`y !== 0 ? x / y : 0`), and the C-style guard
 * (`if (y) result = x / y;`). Each pattern is anchored on the divisor
 * relationship so unrelated `if` statements on the same line don't
 * spuriously suppress.
 *
 * Conservative on purpose: the check is already advisory. Missing a
 * guard that should suppress is fine (FP); falsely suppressing a real
 * division-by-zero (FN) would defeat the check.
 */
function lineHasZeroGuard(line: string): boolean {
	// `... if <id> > 0 else ...` / `... if <id> != 0 else ...` /
	// `... if <id> is not None and <id> != 0 else ...`
	if (/\bif\s+[A-Za-z_$][\w$]*\s*(?:>\s*0|>=\s*1|!=\s*0|!==\s*0|is\s+not\s+None)\b/.test(line)) {
		return true;
	}
	// `... if (<id> > 0)` / `... if (<id> != 0)`  — parenthesized form.
	if (/\bif\s*\(\s*[A-Za-z_$][\w$]*\s*(?:>\s*0|!=\s*0|!==\s*0)\s*\)/.test(line)) {
		return true;
	}
	// JS/Go ternary: `<id> > 0 ? a / <id> : 0` / `<id> ? a / <id> : 0`.
	if (/\b[A-Za-z_$][\w$]*\s*(?:>\s*0|!==?\s*0)\s*\?[^?]*\//.test(line)) return true;
	// `<id> && a / <id>` short-circuit.
	if (/\b[A-Za-z_$][\w$]*\s*&&\s*[A-Za-z_$][\w$]*\s+\/\s+[A-Za-z_$]/.test(line)) return true;
	return false;
}

/**
 * Walk a Python file's stripped content and collect every identifier
 * that's annotated as `Path` / `pathlib.Path` or assigned the result of
 * `Path(...)` / `pathlib.Path(...)`. These names participate in
 * `__truediv__` overloads and `name / "subdir"` is NOT division.
 *
 * Conservative: a name that's BOTH a Path and a number (rare) will be
 * suppressed even when a real division could happen. The check is
 * advisory.
 */
function collectPathishNames(strippedSrc: string): Set<string> {
	const names = new Set<string>();
	// `name: Path` / `name: pathlib.Path` annotations (function args
	// AND assignment annotations).
	const annotRe = /\b([A-Za-z_$][\w$]*)\s*:\s*(?:pathlib\s*\.\s*)?Path\b/g;
	for (const m of strippedSrc.matchAll(annotRe)) names.add(m[1]);
	// `name = Path(...)` / `name = pathlib.Path(...)`.
	const assignRe = /\b([A-Za-z_$][\w$]*)\s*=\s*(?:pathlib\s*\.\s*)?Path\s*\(/g;
	for (const m of strippedSrc.matchAll(assignRe)) names.add(m[1]);
	return names;
}

/**
 * Return true when the matched division shape is actually a
 * `pathlib.Path` __truediv__ join — either the LHS is a known
 * Path-typed name, or the `/` is followed by a string literal in the
 * ORIGINAL line (which got stripped to `""` in the analyzed line, but
 * is still visible in the original).
 */
function isPathDivisionLine(
	strippedLine: string,
	originalLine: string,
	pathishNames: Set<string>,
): boolean {
	// Re-run the regex globally to inspect every match.
	const re = /(?:^|[^\w$])([a-zA-Z_$]\w*)\s+\/\s+([a-zA-Z_$]\w*)/g;
	let m: RegExpExecArray | null;
	let anyNonPathDivision = false;
	let foundAnyMatch = false;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration
	while ((m = re.exec(strippedLine)) !== null) {
		foundAnyMatch = true;
		const lhs = m[1];
		if (pathishNames.has(lhs)) continue; // pathlib join — skip
		anyNonPathDivision = true;
	}
	if (!foundAnyMatch) return false;
	// If every match has a Path-typed LHS, this is a path-join line.
	if (!anyNonPathDivision) return true;
	// Path / "literal" shape: stripped line shows `name / ""` because
	// the literal was stripped. Inspect the original to confirm.
	if (/\b[A-Za-z_$][\w$]*\s+\/\s+(?:["'`])/.test(originalLine)) return true;
	return false;
}

// ===========================================
// Phase 2 D.1 — Plan 04 patterns 11-30 (high-leverage subset)
// ===========================================
//
// First three landed inline below; remaining 17 follow under
// "Plan 04 D.1 — backlog detectors (17 of 20)" further down.

/**
 * `ubs_eval_input` — `eval(...)` / `Function(...)` / `exec(...)` with a
 * non-string-literal argument. pre_block / error.
 *
 * The existing `checkEvalUsage` flags the raw keyword; this detector
 * specifically targets the tainted-input variant where an identifier
 * (likely a parameter or external value) is the first argument. Cross-
 * language: JS `eval` / `Function`; Python `eval` / `exec` / `compile`.
 * Skips test files because fixtures sometimes legitimately stress eval.
 */
export function checkEvalInputTainted(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const isJs = ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs";
	const isTs = ext === ".ts" || ext === ".tsx";
	const isPy = ext === ".py";
	if (!isJs && !isTs && !isPy) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// 139-repo audit (2026-05): cross-language gate. In JS/TS, bare
	// `exec(cmd)` is almost always Node `child_process.exec` (shell-out,
	// caught separately by `child_process_exec_user_input`). Bare
	// `compile(...)` doesn't exist as a global in JS. Restrict the JS/TS
	// match to `eval` / `Function` only — the true eval-class. Python
	// keeps the full `eval` / `exec` / `compile` set.
	//
	// `(?<![.\w])` excludes member-call forms (`.exec(input)` /
	// `.compile(input)` — regex methods, NOT global eval) and identifier-
	// prefix forms (`fooexec(...)` is a custom function, not the eval-
	// class). `\b` alone treated `.` as a word boundary and produced FPs
	// on every `re.exec(x)`.
	const re = isPy
		? /(?<![.\w])(?:eval|exec|compile)\s*\(\s*(?!["'`])([A-Za-z_$]\w*)/g
		: /(?<![.\w])(?:eval|Function)\s*\(\s*(?!["'`])([A-Za-z_$]\w*)/g;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		re.lastIndex = 0;
		if (!re.test(strippedLines[i])) continue;
		// 139-repo audit: respect Bandit `# noqa: S307 / S102` on the
		// same line. Supermodel's mcpbr/custom_metrics.py:347 was the
		// canonical case (sandboxed eval + intent comment). The check
		// anchors on the call line, so a same-line noqa is sufficient
		// (Python convention).
		if (lineHasNoqaSuppression(originalLines[i], "ubs_eval_input_tainted")) continue;
		matches.push({
			line: i + 1,
			text: originalLines[i].trim().slice(0, 150),
		});
	}
	return matches;
}

/**
 * `child_process_exec_user_input` — Node's `child_process.exec(userInput)`
 * family with a non-literal first argument. Command-injection vector.
 * pre_block / error.
 *
 * Complements `ubs_subprocess_shell_true` (Python-only) and
 * `ubs_eval_input_tainted` (which catches bare `exec(x)` after destructuring
 * but skips namespaced forms because of the negative-lookbehind on `.`).
 *
 * Detects the namespaced shapes:
 *   child_process.exec(userInput)
 *   cp.execSync(req.body)
 *   childProcess.spawn(input, args, { shell: true })   (when first arg is a var)
 *
 * The `(?!["'\`])` excludes string literals — a hardcoded command string is
 * not the user-input form. Skips test files because fixtures stress this.
 */
export function checkChildProcessExecUserInput(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const isJs = ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs";
	const isTs = ext === ".ts" || ext === ".tsx";
	if (!isJs && !isTs) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const commentStripped = stripCommentsPreservingStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const matchedLines = new Set<number>();

	// `(child_process|cp|childProcess).<fn>(<identifier>` — must be namespaced
	// AND first arg must be an identifier (not a string literal). The
	// `(?!["'\`])` after the open-paren excludes literal-only invocations.
	const re =
		/\b(?:child_process|childProcess|cp)\.(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(\s*(?!["'`])([A-Za-z_$]\w*)/g;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		re.lastIndex = 0;
		if (!re.test(strippedLines[i])) continue;
		matchedLines.add(i + 1);
		matches.push({
			line: i + 1,
			text: originalLines[i].trim().slice(0, 150),
		});
	}

	const templateRe =
		/\b(?:child_process|childProcess|cp)\.(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(\s*`(?:\\[\s\S]|[^`\\])*?\$\{(?:\\[\s\S]|[^`\\])*?`/g;
	for (const m of commentStripped.matchAll(templateRe)) {
		if (matches.length >= 10) break;
		const idx = m.index ?? 0;
		const lineNum = commentStripped.slice(0, idx).split("\n").length;
		if (matchedLines.has(lineNum)) continue;
		matchedLines.add(lineNum);
		matches.push({
			line: lineNum,
			text: originalLines[lineNum - 1].trim().slice(0, 150),
		});
	}
	return matches;
}

/**
 * `mixed_sync_async_file_api` — function body contains both `fs.*Sync` calls
 * and `await fs.*` / `await fsp.*` calls. Almost always a partial-conversion
 * bug where someone migrated some calls to async but missed others.
 * pre_block / error.
 *
 * Detection per function: split content into function-shaped chunks, then
 * for each chunk check that BOTH a `\b\w+Sync\s*\(` (any identifier ending
 * in Sync) AND an `await\s+\w+\.(?:read|write|stat|...)` co-occur AND at
 * least one of the references is to fs/fsp/promises. Conservative — false
 * negatives are fine; the FP rate must stay zero.
 */
export function checkMixedSyncAsyncFileApi(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const isJs = ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs";
	const isTs = ext === ".ts" || ext === ".tsx";
	if (!isJs && !isTs) return [];
	if (isTestFile(filePath)) return [];
	if (!/\bfs\b|\bfsp\b|node:fs|"fs"|'fs'/.test(content)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const fsApiCalls = new Set([
		"readFile", "writeFile", "readdir", "stat", "lstat", "open",
		"close", "unlink", "mkdir", "rmdir", "rm", "rename", "copyFile",
		"chmod", "chown", "appendFile", "access", "readlink", "symlink",
	]);
	const syncRe = new RegExp(`\\b(?:fs|fsp)\\.(?:${[...fsApiCalls].join("|")})Sync\\s*\\(`, "g");
	const awaitRe = new RegExp(`\\bawait\\s+(?:fs|fsp)\\.(?:${[...fsApiCalls].join("|")})\\s*\\(`, "g");

	// pre_block/error: the FP budget is zero. A sliding window cross-flags
	// sibling helpers (one with `fs.readFileSync`, the next with
	// `await fs.readFile`) even when no single function mixes the two. Scope
	// to function bodies via brace-balanced extraction, then mask out nested
	// function bodies so a child function's `await` doesn't taint its parent.
	const bodies = findFunctionBodies(stripped);
	const seenLines = new Set<number>();
	for (const body of bodies) {
		if (matches.length >= 10) break;
		const localBody = maskNestedBodies(stripped, body, bodies);
		if (!syncRe.test(localBody)) continue;
		syncRe.lastIndex = 0;
		const awaitMatch = awaitRe.exec(localBody);
		awaitRe.lastIndex = 0;
		if (!awaitMatch) continue;
		const absoluteIdx = body.start + awaitMatch.index;
		const lineNum = stripped.slice(0, absoluteIdx).split("\n").length;
		if (seenLines.has(lineNum)) continue;
		seenLines.add(lineNum);
		matches.push({
			line: lineNum,
			text: originalLines[lineNum - 1].trim().slice(0, 150),
		});
	}
	return matches;
}

interface FunctionBody {
	start: number;
	end: number;
}

/**
 * Extract function/method/arrow body byte ranges from `src`. Ranges are
 * (open-brace + 1, close-brace) — i.e. the body interior. Caller is
 * responsible for filtering nested bodies when analyzing a single body.
 */
function findFunctionBodies(src: string): FunctionBody[] {
	const ranges: FunctionBody[] = [];
	const controlKeyword = /\b(?:if|while|for|switch|catch|do|else)\s*$/;
	// Match `)` or `=>` followed by an optional return-type annotation and `{`.
	const re = /(\)|=>)\s*(?::[^{=;]+)?\{/g;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration
	while ((m = re.exec(src)) !== null) {
		const openIdx = m.index + m[0].length - 1;
		// Skip control-flow constructs whose `) {` looks like a function start.
		if (m[1] === ")") {
			const before = src.slice(Math.max(0, m.index - 32), m.index);
			if (controlKeyword.test(before)) continue;
		}
		let depth = 1;
		let j = openIdx + 1;
		while (j < src.length && depth > 0) {
			const c = src[j];
			if (c === "{") depth++;
			else if (c === "}") depth--;
			j++;
		}
		if (depth === 0) ranges.push({ start: openIdx + 1, end: j - 1 });
	}
	return ranges;
}

/**
 * Return the body slice with strictly-nested function bodies blanked out
 * (newlines preserved). A nested helper's `await` cannot taint its parent
 * function once its body is masked.
 */
function maskNestedBodies(src: string, body: FunctionBody, all: FunctionBody[]): string {
	const slice = src.slice(body.start, body.end).split("");
	for (const inner of all) {
		if (inner.start <= body.start || inner.end >= body.end) continue;
		const localStart = inner.start - body.start;
		const localEnd = inner.end - body.start;
		for (let i = localStart; i < localEnd; i++) {
			if (slice[i] !== "\n") slice[i] = " ";
		}
	}
	return slice.join("");
}

/**
 * Walk forward from the position of an opening `(` and return the substring
 * between the parens, balanced. Returns null if the call doesn't close within
 * `maxLen` characters or runs to EOF unmatched.
 */
function sliceBalancedParens(src: string, openIdx: number, maxLen = 2000): string | null {
	if (src[openIdx] !== "(") return null;
	let depth = 1;
	let j = openIdx + 1;
	const end = Math.min(src.length, openIdx + maxLen);
	while (j < end && depth > 0) {
		const c = src[j];
		if (c === "(") depth++;
		else if (c === ")") depth--;
		j++;
	}
	if (depth !== 0) return null;
	return src.slice(openIdx + 1, j - 1);
}

/**
 * Given a function-call argument list, extract the body of the first
 * top-level `{...}` object literal so security flags can be inspected even
 * when nested calls or arrays appear before/after it.
 */
function extractTopLevelObject(args: string): string {
	const openIdx = args.indexOf("{");
	if (openIdx < 0) return "";
	let depth = 1;
	let j = openIdx + 1;
	while (j < args.length && depth > 0) {
		const c = args[j];
		if (c === "{") depth++;
		else if (c === "}") depth--;
		j++;
	}
	if (depth !== 0) return args.slice(openIdx + 1);
	return args.slice(openIdx + 1, j - 1);
}

/**
 * `cookie_missing_security_flags` — `Set-Cookie` written via `res.cookie(...)`
 * / `res.setHeader('Set-Cookie', ...)` / `cookies.set(...)` without both
 * `httpOnly: true` AND `secure: true`. Session-fixation / theft vector.
 * pre_block / error.
 *
 * Detection flags cookie-set calls that either omit an options object entirely
 * or include same-call options/header text missing one or both flags. Skips
 * test files.
 */
export function checkCookieMissingSecurityFlags(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const isJs = ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs";
	const isTs = ext === ".ts" || ext === ".tsx";
	if (!isJs && !isTs) return [];
	if (isTestFile(filePath)) return [];
	if (!/cookie/i.test(content)) return [];

	const stripped = stripCommentsPreservingStrings(content);
	const matches: InlineMatch[] = [];
	const originalLines = content.split("\n");

	// Match `res.cookie(...)` / `cookies.set(...)`, then balance parens forward
	// from the opening `(`. A non-greedy `.*?\)` regex stops at the first `)`,
	// so common secure cookies whose options object contains nested calls
	// (e.g. `expires: new Date(...)`) get truncated before the security flags
	// can be inspected — and pre_block fires a false positive.
	const cookieCallRe = /\b(?:res\.cookie|cookies\.set)\s*\(/g;
	for (const m of stripped.matchAll(cookieCallRe)) {
		if (matches.length >= 10) break;
		const openIdx = (m.index ?? 0) + m[0].length - 1;
		const args = sliceBalancedParens(stripped, openIdx);
		if (args === null) continue;
		const opts = extractTopLevelObject(args);
		const hasHttpOnly = /\bhttpOnly\s*:\s*true\b/i.test(opts);
		const hasSecure = /\bsecure\s*:\s*true\b/i.test(opts);
		if (hasHttpOnly && hasSecure) continue;
		const idx = m.index ?? 0;
		const lineNum = stripped.slice(0, idx).split("\n").length;
		matches.push({
			line: lineNum,
			text: originalLines[lineNum - 1].trim().slice(0, 150),
		});
	}

	const setHeaderRe =
		/\b(?:[A-Za-z_$]\w*\.)?setHeader\s*\(\s*(['"`])Set-Cookie\1\s*,\s*([\s\S]{0,400}?)\)/g;
	for (const m of stripped.matchAll(setHeaderRe)) {
		if (matches.length >= 10) break;
		const headerValue = m[2] || "";
		const hasHttpOnly = /\bHttpOnly\b/i.test(headerValue);
		const hasSecure = /\bSecure\b/i.test(headerValue);
		if (hasHttpOnly && hasSecure) continue;
		const idx = m.index ?? 0;
		const lineNum = stripped.slice(0, idx).split("\n").length;
		if (matches.some((match) => match.line === lineNum)) continue;
		matches.push({
			line: lineNum,
			text: originalLines[lineNum - 1].trim().slice(0, 150),
		});
	}
	return matches;
}

/**
 * `logger_format_user_input` — `logger.<level>(userInput, ...)` where the
 * first argument is a non-literal expression that references a request-bound
 * identifier. Format-string injection / log poisoning vector. pre_block /
 * error.
 *
 * Narrow seed list: logger / log / console with the suspicious-source
 * identifiers (req, ctx, input, user, params, body, query) on the first
 * argument. Conservative; expand only if FP rate stays at 0 in dogfood.
 */
export function checkLoggerFormatUserInput(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const isJs = ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs";
	const isTs = ext === ".ts" || ext === ".tsx";
	if (!isJs && !isTs) return [];
	if (isTestFile(filePath)) return [];
	if (!/\b(?:logger|log|console)\.(?:info|warn|error|debug|trace|fatal)\b/.test(content)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// `logger.<level>(<sourceIdent>...` where <sourceIdent> starts with one
	// of the request-bound prefixes. Excludes string-literal first arg via
	// the negative lookahead.
	const re =
		/\b(?:logger|log|console)\.(?:info|warn|error|debug|trace|fatal)\s*\(\s*(?!["'`])(req|ctx|input|user|params|body|query|userInput|userMsg)\b/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		if (!re.test(strippedLines[i])) continue;
		matches.push({
			line: i + 1,
			text: originalLines[i].trim().slice(0, 150),
		});
	}
	return matches;
}

/**
 * `ubs_sql_string_concat` — SQL keyword in a quoted string immediately
 * followed by JS/Py concatenation/interpolation with an identifier.
 * pre_block / error.
 *
 * Detects:
 *   - `"SELECT * FROM " + table` (string +)
 *   - `` `SELECT * WHERE id = ${userId}` `` (template literal injection)
 *   - `"SELECT " + col + " FROM " + table` (Python-style)
 *
 * Does NOT fire on parameterized queries (`db.query("...$1...", [v])`),
 * which are the safe form. Skips test files.
 */
export function checkSqlStringConcat(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const isCode =
		ext === ".ts" ||
		ext === ".tsx" ||
		ext === ".js" ||
		ext === ".jsx" ||
		ext === ".mjs" ||
		ext === ".cjs" ||
		ext === ".py" ||
		ext === ".go" ||
		ext === ".rs";
	if (!isCode) return [];
	if (isTestFile(filePath)) return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	// Tightened verb forms — earlier `UPDATE` / `DROP` / `TRUNCATE` matched
	// plain English ("dirty update:", "drop the file", etc.). Each verb now
	// requires the syntactic neighbor that disambiguates SQL from prose.
	const sqlVerb =
		/\b(?:SELECT\s+(?:\*|DISTINCT\s|[\w,\s]+\s+FROM)|INSERT\s+INTO\s+\w+|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\s+\w+|DROP\s+(?:TABLE|INDEX|DATABASE|SCHEMA|VIEW)\b|TRUNCATE\s+TABLE\b)/i;
	const selectConcatPrefix = /\bSELECT\s*["'`]\s*[+,]/i;
	const interpolation = /["'`].*[+,]\s*[A-Za-z_$]\w*|`[^`]*\$\{[^}]*\}[^`]*`/;

	// Helicone audit (2026-05): the check was firing 66 times on
	// `WHERE id = $1` style PARAMETERIZED queries — the `$N` placeholder
	// IS the safe form. Same for `?` (positional) and `:name` (named).
	// Skip any line that contains a recognizable parameterized-query
	// placeholder, regardless of what follows it.
	const placeholder = /\$\d+\b|[=(,\s]\?[\s,)]|:\w+\b/;
	// Event-handler shapes that look SQL-y because of an interpolated
	// callback arg ("`click`", "${selector}") but are not SQL.
	const eventListener = /\.\s*(?:on|once|addEventListener|removeEventListener)\s*\(/;

	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= 10) break;
		const line = originalLines[i];
		if (!sqlVerb.test(line) && !selectConcatPrefix.test(line)) continue;
		if (!interpolation.test(line)) continue;
		// Tightening: parameterized queries are safe — skip them.
		if (placeholder.test(line)) continue;
		// Tightening: event-handler shapes aren't SQL — skip them.
		if (eventListener.test(line)) continue;
		matches.push({ line: i + 1, text: line.trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_python_mutable_default_arg` — `def f(x=[])` / `def f(x={})`.
 * post / warning.
 *
 * Python's default-argument values are evaluated ONCE at function-def
 * time. A mutable default ([] or {}) is shared across every invocation —
 * one of Python's classic gotchas. The detector matches `def NAME(args... = [])`
 * with a literal list/dict/set as default value.
 */
export function checkPyMutableDefaultArg(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".py") return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];
	const re = /\bdef\s+\w+\s*\([^)]*=\s*(\[\s*\]|\{\s*\}|set\(\))/;

	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= 10) break;
		if (!re.test(originalLines[i])) continue;
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}

// ===========================================
// Plan 04 D.1 — backlog detectors (17 of 20)
// ===========================================
// Each detector follows the template established by checkPyMutableDefaultArg /
// checkSqlStringConcat: ext gate, scan content, return InlineMatch[].

const PY_EXTS = [".py", ".pyi"] as const;
const JS_TS_EXT_LIST = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"] as const;

function isPyFile(ext: string): boolean {
	return (PY_EXTS as readonly string[]).includes(ext);
}

function isJsTsFile(ext: string): boolean {
	return (JS_TS_EXT_LIST as readonly string[]).includes(ext);
}

const MATCH_LIMIT = 10;

/**
 * `ubs_tempfile_mktemp_race` — Python `tempfile.mktemp()` is a TOCTOU
 * race-condition vector; the file path is returned without holding the file
 * open, so an attacker can win the race and substitute a symlink. pre_warn /
 * error.
 */
export function checkTempfileMktempRace(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isPyFile(ext)) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const re = /\btempfile\.mktemp\s*\(/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		if (!re.test(strippedLines[i])) continue;
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_pickle_untrusted_load` — Python `pickle.load(...)` / `pickle.loads(...)`
 * unpickles arbitrary bytes, which can execute attacker-controlled `__reduce__`
 * code on import. pre_warn / error.
 */
export function checkPickleUntrustedLoad(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isPyFile(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	// Match pickle.load / pickle.loads / cPickle.load{,s}
	const re = /\b(?:c?[Pp]ickle|cPickle)\.loads?\s*\(/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		if (!re.test(strippedLines[i])) continue;
		// 139-repo audit: respect Bandit `# noqa: S301`.
		if (lineHasNoqaSuppression(originalLines[i], "ubs_pickle_untrusted_load")) continue;
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_xml_external_entity` — Python XML parsing without disabling external
 * entity resolution exposes the parser to XXE attacks. Fires when an unsafe
 * stdlib parser (`xml.etree`, `xml.dom`, `xml.sax`, `lxml.etree`) is BOTH
 * imported AND used to parse input (`ET.parse(...)`, `ET.fromstring(...)`,
 * `XMLParser(...)`, `XMLPullParser(...)`, `lxml.etree.parse(...)`,
 * `lxml.etree.fromstring(...)`). pre_warn / error.
 *
 * 139-repo audit (2026-05): an import-only gate produced 2 FPs in
 * Supermodel's `mcpbr/src/mcpbr/{junit_reporter,reporting}.py` — both
 * import `xml.etree.ElementTree as ET` only to BUILD/WRITE XML, never
 * to parse untrusted input. XXE risk requires actual parsing of
 * potentially-tainted input; writing XML is safe.
 */
const XML_PARSE_CALL_RE =
	/\b(?:ET|etree|xml\.etree(?:\.\w+)*|lxml\.etree)\s*\.\s*(?:parse|fromstring|XMLParser|XMLPullParser|iterparse)\s*\(|\bXMLPullParser\s*\(/;

export function checkXmlExternalEntity(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isPyFile(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// `import xml.etree...`, `from xml.etree...`, `from xml.dom...`,
	// `from xml.sax...`, or `from lxml import ...etree`.
	const re =
		/\b(?:import\s+xml\.(?:etree|dom|sax)|from\s+xml\.(?:etree|dom|sax)|from\s+lxml\b)/;

	// Skip files that already use defusedxml — the safe form.
	if (/\bdefusedxml\b/.test(stripped)) return [];

	// 139-repo audit: require an actual parse call somewhere in the
	// file. Import-only files (write-only XML reporters) are safe.
	if (!XML_PARSE_CALL_RE.test(stripped)) return [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		if (!re.test(strippedLines[i])) continue;
		// 139-repo audit: respect Bandit `# noqa: S314 / S320`.
		if (lineHasNoqaSuppression(originalLines[i], "ubs_xml_external_entity")) continue;
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_os_system_tainted` — Python `os.system(x)` / `os.popen(x)` invoked with
 * a non-literal first argument (likely user input). Subprocess + shell=True
 * sibling: `os.system` always goes through `/bin/sh`, so any string
 * concatenation here is command-injection territory. pre_warn / error.
 */
export function checkOsSystemTainted(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isPyFile(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// os.system(name) / os.popen(name) where the first arg is an identifier
	// (not a string literal — those were stripped by stripCommentsAndStrings).
	const re = /\bos\.(?:system|popen)\s*\(\s*[A-Za-z_]\w*/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		if (!re.test(strippedLines[i])) continue;
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_unsafe_format_string` — C/C++ `printf` / `sprintf` / `fprintf` family
 * with a non-literal format string. A user-controlled format spec can leak
 * stack memory (`%x`) or write arbitrary memory (`%n`). pre_warn / error.
 */
export function checkUnsafeFormatString(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const isC = ext === ".c" || ext === ".h";
	const isCpp =
		ext === ".cpp" ||
		ext === ".cc" ||
		ext === ".cxx" ||
		ext === ".hpp" ||
		ext === ".hxx" ||
		ext === ".hh";
	if (!isC && !isCpp) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// printf-family format-string position varies by function:
	//   printf(fmt)              — format in slot 1
	//   fprintf(stream, fmt)     — format in slot 2
	//   sprintf(buf, fmt)        — format in slot 2
	//   snprintf(buf, n, fmt)    — format in slot 3 (slot 2 is the size)
	// Common bug: `snprintf(buf, n, "%s", input)` is SAFE — `n` is the size,
	// `"%s"` is the literal format. The earlier two-arg regex misclassified
	// `snprintf` as having its format at slot 2 and flagged the size
	// argument (an identifier) as a tainted format. snprintf must be its
	// own pattern with the size slot skipped.
	const onePosRe = /\bprintf\s*\(\s*([A-Za-z_]\w*)\s*[,)]/;
	const twoPosRe = /\b(?:sprintf|fprintf)\s*\(\s*[^,]+?,\s*([A-Za-z_]\w*)\s*[,)]/;
	const threePosRe = /\bsnprintf\s*\(\s*[^,]+?,\s*[^,]+?,\s*([A-Za-z_]\w*)\s*[,)]/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const stripLine = strippedLines[i];
		if (
			!onePosRe.test(stripLine) &&
			!twoPosRe.test(stripLine) &&
			!threePosRe.test(stripLine)
		) {
			continue;
		}
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_unchecked_redirect` — JS/TS `redirect(url)` / `location.href = url` /
 * `res.redirect(url)` with a non-literal URL is an open-redirect vector when
 * `url` originates from a request param. pre_warn / error.
 */
export function checkUncheckedRedirect(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isJsTsFile(ext)) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// `redirect(x)` / `<obj>.redirect(x)` / `location.href = x` / `window.location = x`.
	// Anchored on identifier (not `""` literal — strings were stripped).
	const callRe = /\b(?:redirect|location\.href|window\.location)\s*[=(]\s*([A-Za-z_$]\w*)/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const stripLine = strippedLines[i];
		if (!callRe.test(stripLine)) continue;
		// Skip lines that look like a relative-path string assignment intent —
		// those were stripped to `""`, so an empty arg slot won't match here.
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_goroutine_no_waitgroup` — Go `go func() { ... }()` started without an
 * accompanying `wg.Add` / `wg.Done` pair (or other synchronization context).
 * Fire-and-forget goroutines leak when the caller exits before they complete.
 * post / warning.
 *
 * Heuristic: a `go func` line whose surrounding ±200-char window contains no
 * `wg.Add`, `wg.Done`, `errgroup`, `sync.WaitGroup`, or `<-` channel receive.
 */
export function checkGoroutineNoWaitgroup(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".go") return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];
	const goRe = /\bgo\s+func\b/g;
	const SAFE_CONTEXT_RE =
		/\b(?:wg\.(?:Add|Done|Wait)|errgroup|sync\.WaitGroup|<-\s*\w|\.Wait\(\))/;
	const WINDOW = 240;

	for (const m of stripped.matchAll(goRe)) {
		if (matches.length >= MATCH_LIMIT) break;
		const idx = m.index ?? 0;
		const start = Math.max(0, idx - WINDOW);
		const end = Math.min(stripped.length, idx + WINDOW);
		const window = stripped.slice(start, end);
		if (SAFE_CONTEXT_RE.test(window)) continue;
		const lineNum = stripped.slice(0, idx).split("\n").length;
		matches.push({
			line: lineNum,
			text: originalLines[lineNum - 1].trim().slice(0, 150),
		});
	}
	return matches;
}

/**
 * `ubs_defer_in_loop` — Go `defer` inside a `for` loop accumulates calls
 * until the function returns; if the loop iterates many times you blow up
 * memory / leak file handles before any defer executes. post / warning.
 *
 * Heuristic: track loop nesting via simple `for ` line scan; flag any
 * `defer ` line that appears while loop depth > 0.
 */
export function checkDeferInLoop(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".go") return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// Track function depth and loop depth separately. A `defer` is fine at
	// the top of a function but NOT inside a `for` body.
	let braceDepth = 0;
	let loopDepth = 0;
	// Stack of brace-depths at which a `for` loop was entered.
	const loopStack: number[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const line = strippedLines[i];

		// Count braces opening before checking the line content.
		const openCount = (line.match(/\{/g) || []).length;
		const closeCount = (line.match(/\}/g) || []).length;

		// Detect a `for` loop on this line.
		const forMatch = /\bfor\b/.test(line);
		if (forMatch && openCount > 0) {
			loopStack.push(braceDepth);
			loopDepth++;
		}

		// Now if we're inside a loop and the line has `defer `, flag it.
		if (loopDepth > 0 && /\bdefer\s+\w/.test(line)) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
		}

		// Apply brace depth changes for next iteration.
		braceDepth += openCount - closeCount;

		// Pop loops whose entry depth is now above the current depth.
		while (loopStack.length > 0 && loopStack[loopStack.length - 1] >= braceDepth) {
			loopStack.pop();
			loopDepth--;
		}
	}
	return matches;
}

/**
 * `ubs_string_concat_in_loop` — `result += chunk` inside a loop is O(n²) in
 * languages with immutable strings (Java, JS-pre-rope). post / warning.
 *
 * Heuristic: scan for `+=` on an identifier inside a `for`/`while` body.
 * Gates Java + JS/TS only — Python and Go are already covered by the older,
 * indent-aware `checks/performance.ts:checkStringConcatInLoop` (which uses
 * `getLoopBodies()`). Without this language gate, both detectors fire on
 * the same line with different `(name, message)` pairs and the post-event
 * dedup (which keys on `(file, line, normalizedMessage)`) won't collapse
 * them — agents see two warnings for one issue.
 */
export function checkUbsStringConcatInLoop(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const supported = ext === ".java" || isJsTsFile(ext);
	if (!supported) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	let loopDepth = 0;
	let braceDepth = 0;
	let inPyLoop = false;
	let pyLoopIndent = -1;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const line = strippedLines[i];

		// Python: track via leading-whitespace indent (no braces).
		if (ext === ".py") {
			const indent = line.search(/\S/);
			if (inPyLoop && indent !== -1 && indent <= pyLoopIndent) {
				inPyLoop = false;
				pyLoopIndent = -1;
			}
			if (/^\s*(?:for\b|while\b)/.test(line)) {
				inPyLoop = true;
				pyLoopIndent = indent;
			}
			if (
				inPyLoop &&
				indent > pyLoopIndent &&
				/\b[A-Za-z_]\w*\s*\+=\s*[A-Za-z_"'`]/.test(line)
			) {
				matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
			}
			continue;
		}

		// JS/TS/Java/Go: brace-tracked loop depth.
		const openCount = (line.match(/\{/g) || []).length;
		const closeCount = (line.match(/\}/g) || []).length;

		if (/\b(?:for|while)\b[^{]*\{/.test(line)) {
			loopDepth++;
		}
		if (loopDepth > 0 && /\b[A-Za-z_$]\w*\s*\+=\s*[A-Za-z_$"'`]/.test(line)) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
		}
		braceDepth += openCount - closeCount;
		// Roughly pop loop depth when braces close — heuristic only.
		if (loopDepth > 0 && closeCount > openCount) {
			loopDepth = Math.max(0, loopDepth - (closeCount - openCount));
		}
	}
	return matches;
}

/**
 * `ubs_numeric_comparison_chain` — Java `instanceof` chain or `compareTo`
 * cascade — typically a sign of missing polymorphism. Flags 3+ consecutive
 * `instanceof` lines or `compareTo` lines in the same scope. post / warning.
 */
export function checkNumericComparisonChain(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".java") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// Run-length scan: if 3+ consecutive lines (allowing closing braces between)
	// contain `instanceof` or `compareTo`, flag the first line of the run.
	let runStart = -1;
	let runLen = 0;
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const has =
			/\binstanceof\b/.test(strippedLines[i]) ||
			/\bcompareTo\s*\(/.test(strippedLines[i]);
		if (has) {
			if (runStart === -1) runStart = i;
			runLen++;
		} else if (/^\s*[}\s]*$/.test(strippedLines[i])) {
			// blank or brace-only line: tolerate inside a run
		} else {
			if (runLen >= 3 && runStart !== -1) {
				matches.push({
					line: runStart + 1,
					text: originalLines[runStart].trim().slice(0, 150),
				});
			}
			runStart = -1;
			runLen = 0;
		}
	}
	if (runLen >= 3 && runStart !== -1 && matches.length < MATCH_LIMIT) {
		matches.push({
			line: runStart + 1,
			text: originalLines[runStart].trim().slice(0, 150),
		});
	}
	return matches;
}

/**
 * `ubs_print_debug_leak` — `console.log` / Python `print(...)` / Go
 * `fmt.Println` left in non-test code. Often a debug breadcrumb forgotten
 * before commit. post / warning.
 *
 * Skips test files, CLI/command files (where stdout is the product), and
 * files where the call is wrapped in `if (process.env.DEBUG)` style guards.
 */
export function checkPrintDebugLeak(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const supported =
		isJsTsFile(ext) || isPyFile(ext) || ext === ".go";
	if (!supported) return [];
	if (isTestFile(filePath)) return [];
	// CLI/commands: stdout is the product; consoleStatements check covers them.
	if (filePath.includes("/commands/") || filePath.includes("/cmd/") || filePath.includes("/bin/")) {
		return [];
	}
	// 139-repo audit: mcpbr's `scripts/sync_version.py` had 194 print()
	// hits — all CLI output. Supermodel's `cli/internal/setup/wizard.go`
	// had 13 fmt.Println — interactive setup wizard. Path-segment gate
	// covers `scripts/`, `script/`, `cli/`, `tools/`, `tool/`,
	// `tutorial[s]/` — all places where stdout IS the product.
	if (isScriptOrCliPath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	const re = /\b(?:console\.log|print|fmt\.Println)\s*\(/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		if (!re.test(strippedLines[i])) continue;
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_hardcoded_localhost` — `localhost` / `127.0.0.1` baked into source
 * outside of test/config/example files. Often committed dev defaults that
 * break in deploy. pre_block / error.
 *
 * Distinct from `checks/supply-chain.ts:checkHardcodedLocalhost` (JS/TS
 * only, requires explicit port). This UBS variant is cross-language and
 * matches plain `localhost` / `127.0.0.1` outside known config/test paths.
 */
export function checkUbsHardcodedLocalhost(content: string, filePath: string): InlineMatch[] {
	// Source-code extensions only. The original detector had no extension
	// gate and FP'd on docs (.md plan files referencing the literal token),
	// configuration manifests (.yaml/.toml deploy configs that legitimately
	// pin localhost for local dev), and JSONL log lines. Restrict to file
	// types where a hardcoded localhost is a real shipped-config bug.
	const ext = getExtension(filePath);
	const isSource =
		ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" ||
		ext === ".mjs" || ext === ".cjs" ||
		ext === ".py" || ext === ".pyi" ||
		ext === ".go" || ext === ".rs" ||
		ext === ".java" || ext === ".kt" || ext === ".swift" ||
		ext === ".rb" || ext === ".php" ||
		ext === ".c" || ext === ".cc" || ext === ".cpp" || ext === ".cxx" ||
		ext === ".h" || ext === ".hpp" || ext === ".hxx";
	if (!isSource) return [];
	if (isTestFile(filePath)) return [];
	const normalized = filePath.replace(/\\/g, "/").toLowerCase();
	// Match "example", "examples", "fixtures", "dev" as path segments — leading
	// slash is optional so a top-level `examples/` directory is excluded too.
	if (
		/(^|\/)examples?\//.test(normalized) ||
		normalized.includes("/fixtures/") ||
		/(^|\/)dev\//.test(normalized) ||
		normalized.includes("config") ||
		normalized.endsWith(".env") ||
		normalized.endsWith(".env.example")
	) {
		return [];
	}

	const originalLines = content.split("\n");
	// Strip regex literals BEFORE comments so /…localhost…/ doesn't survive into
	// the match pass — without this, the check FPs on its own implementation
	// (this file + checks/supply-chain.ts both contain `/…localhost…/`).
	const strippedLines = stripCommentsPreservingStrings(stripRegexLiterals(content)).split("\n");
	const matches: InlineMatch[] = [];
	const re = /\b(?:localhost|127\.0\.0\.1)\b/;
	// Metadata-shape lines (description / label / noun / fix_instruction
	// strings in registry & check-metadata files) legitimately contain the
	// literal token because they describe the check itself. Skipping these
	// drops the self-FP rate to ~0 without weakening detection on real
	// network-config bugs (`url = "http://localhost:3000"`-style).
	const metadataAssignment =
		/\b(?:label|noun|description|passLabel|fix_instruction|name|comment|summary|fix|msg|message)\s*[:=]\s*["'`]/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		if (!re.test(strippedLines[i])) continue;
		if (metadataAssignment.test(strippedLines[i])) continue;
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}

function stripCommentsPreservingStrings(content: string): string {
	const lines = content.split("\n");
	const out: string[] = [];
	let inBlock = false;
	for (const line of lines) {
		let stripped = "";
		let quote: "'" | "\"" | "`" | null = null;
		let escaped = false;
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			const next = line[i + 1];
			if (inBlock) {
				if (ch === "*" && next === "/") {
					inBlock = false;
					i++;
				}
				continue;
			}
			if (quote) {
				stripped += ch;
				if (escaped) {
					escaped = false;
				} else if (ch === "\\") {
					escaped = true;
				} else if (ch === quote) {
					quote = null;
				}
				continue;
			}
			if (ch === "'" || ch === "\"" || ch === "`") {
				quote = ch;
				stripped += ch;
				continue;
			}
			if (ch === "/" && next === "*") {
				inBlock = true;
				i++;
				continue;
			}
			if (ch === "/" && next === "/") break;
			if (ch === "#") break;
			stripped += ch;
		}
		out.push(stripped);
	}
	return out.join("\n");
}

/**
 * `ubs_magic_number_no_const` — numeric literals (other than 0/1/-1/2 and
 * obvious unit conversions) used in expressions without being assigned to a
 * named constant first. post / warning.
 *
 * Heuristic: detect `<numeric-literal-3+digits>` or `<numeric>.<numeric>`
 * appearing in an expression context (not a var/const initializer). Skips
 * test files. Significant FP rate; advisory.
 */
export function checkMagicNumberNoConst(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const supported = isJsTsFile(ext) || isPyFile(ext) || ext === ".go" || ext === ".java";
	if (!supported) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// 3+ digit integer or fractional numeric literal — flag if NOT preceded by
	// `const`/`let`/`var`/`final` (the assignment-to-constant case).
	const re = /\b(?:const|let|var|final)\b\s*\w+\s*=\s*\d+/;
	const magicRe = /(?<![\w.])\d{3,}(?:\.\d+)?\b/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const line = strippedLines[i];
		if (!magicRe.test(line)) continue;
		if (re.test(line)) continue; // declaration with literal — fine
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_large_function` — function whose body spans 80+ lines. Heuristic; uses
 * brace-counting for C-family / `def` indent for Python. post / warning.
 */
export function checkLargeFunction(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const supported =
		isJsTsFile(ext) ||
		isPyFile(ext) ||
		ext === ".go" ||
		ext === ".java" ||
		ext === ".rs" ||
		ext === ".c" ||
		ext === ".cpp";
	if (!supported) return [];
	if (isTestFile(filePath)) return [];

	const LINE_LIMIT = 80;
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	if (isPyFile(ext)) {
		// Python: scan for `def NAME(...)`, then count contiguous body lines
		// at strictly greater indent.
		for (let i = 0; i < strippedLines.length; i++) {
			if (matches.length >= MATCH_LIMIT) break;
			const m = strippedLines[i].match(/^(\s*)def\s+\w+\s*\(/);
			if (!m) continue;
			const headerIndent = m[1].length;
			let bodyLines = 0;
			for (let j = i + 1; j < strippedLines.length; j++) {
				const inner = strippedLines[j];
				if (inner.trim() === "") {
					bodyLines++;
					continue;
				}
				const indent = inner.search(/\S/);
				if (indent <= headerIndent) break;
				bodyLines++;
			}
			if (bodyLines >= LINE_LIMIT) {
				matches.push({
					line: i + 1,
					text: originalLines[i].trim().slice(0, 150),
				});
			}
		}
		return matches;
	}

	// C-family: scan for `function NAME(`, `NAME(...) {`, etc., then count
	// lines until the matching `}`. Heuristic; no full parser.
	const headerRe = /\b(?:function\s+\w+|fn\s+\w+|func\s+\w+|\w+\s*=\s*\([^)]*\)\s*=>)/;
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		if (!headerRe.test(strippedLines[i])) continue;
		// Find the opening `{` from this line forward.
		let openIdx = -1;
		for (let k = i; k < Math.min(i + 5, strippedLines.length); k++) {
			if (strippedLines[k].includes("{")) {
				openIdx = k;
				break;
			}
		}
		if (openIdx === -1) continue;
		// Walk forward, counting braces until we balance.
		let depth = 0;
		let endIdx = -1;
		for (let k = openIdx; k < strippedLines.length; k++) {
			const opens = (strippedLines[k].match(/\{/g) || []).length;
			const closes = (strippedLines[k].match(/\}/g) || []).length;
			depth += opens - closes;
			if (depth === 0 && k > openIdx) {
				endIdx = k;
				break;
			}
		}
		if (endIdx === -1) continue;
		const bodyLines = endIdx - openIdx;
		if (bodyLines >= LINE_LIMIT) {
			matches.push({
				line: i + 1,
				text: originalLines[i].trim().slice(0, 150),
			});
		}
	}
	return matches;
}

/**
 * `ubs_deeply_nested_callback` — JS/TS file with a callback nested 4+ levels
 * deep. Sign of callback hell that's hard to read and test. post / warning.
 *
 * Heuristic: track `function`/`=>` opener lines and count how many are open
 * at the same time using brace depth.
 */
export function checkDeeplyNestedCallback(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isJsTsFile(ext)) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	const NESTING_LIMIT = 4;
	let funcDepth = 0;
	let braceDepth = 0;
	const funcOpenStack: number[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const line = strippedLines[i];

		// Count function-opener occurrences on this line. We treat `function`,
		// `function (`, and `=>` as candidates.
		const funcOpens = ((line.match(/\bfunction\b|=>/g) || [])).length;
		const opens = (line.match(/\{/g) || []).length;
		const closes = (line.match(/\}/g) || []).length;

		// If this line introduces a function and opens a brace, push.
		if (funcOpens > 0 && opens > 0) {
			for (let k = 0; k < Math.min(funcOpens, opens); k++) {
				funcOpenStack.push(braceDepth);
				funcDepth++;
			}
		}

		braceDepth += opens - closes;

		// Pop funcs whose entry depth is now ≥ current.
		while (funcOpenStack.length > 0 && funcOpenStack[funcOpenStack.length - 1] >= braceDepth) {
			funcOpenStack.pop();
			funcDepth = funcOpenStack.length;
		}

		if (funcDepth >= NESTING_LIMIT) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
		}
	}
	return matches;
}

/**
 * `ubs_time_format_locale_dep` — `Date.toLocaleString()` (JS) /
 * `DateTimeFormatter.ofLocalizedXxx` (Java) without an explicit locale.
 * Locale-dependent formatting drifts by environment. post / warning.
 */
export function checkTimeFormatLocaleDep(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const supported = isJsTsFile(ext) || ext === ".java";
	if (!supported) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// JS: toLocaleString / toLocaleDateString / toLocaleTimeString called with no args.
	const jsRe = /\.toLocale(?:String|DateString|TimeString)\s*\(\s*\)/;
	// Java: DateTimeFormatter.ofLocalizedDate(...) without `.withLocale(`.
	const javaRe = /\bDateTimeFormatter\.ofLocalized\w+\s*\([^)]*\)(?!\s*\.withLocale)/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const line = strippedLines[i];
		if (ext === ".java" ? !javaRe.test(line) : !jsRe.test(line)) continue;
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_regex_in_loop_no_compile` — Python `re.match(pattern, ...)` /
 * `re.search(pattern, ...)` / `re.sub(pattern, ...)` invoked inside a `for`/
 * `while` loop without first calling `re.compile`. The regex is recompiled
 * on every iteration. post / warning.
 */
export function checkRegexInLoopNoCompile(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isPyFile(ext)) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	let inLoop = false;
	let loopIndent = -1;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const line = strippedLines[i];
		const indent = line.search(/\S/);
		if (inLoop && indent !== -1 && indent <= loopIndent) {
			inLoop = false;
			loopIndent = -1;
		}
		if (/^\s*(?:for\b|while\b)/.test(line)) {
			inLoop = true;
			loopIndent = indent;
			continue;
		}
		if (inLoop && /\bre\.(?:match|search|sub|fullmatch|findall|finditer)\s*\(/.test(line)) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
		}
	}
	return matches;
}
