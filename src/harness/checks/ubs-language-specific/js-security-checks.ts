// UBS language-specific detectors — JS/TS injection & security checks.
// Extracted from ubs-language-specific.ts during the 1500-line decomposition.
// Each function returns InlineMatch[]. Ext-gated to JS/TS variants.

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	isVendoredOrFixturePath,
	lineHasNoqaSuppression,
	stripCommentsAndStrings,
} from "../shared.js";
import { isJsTsFile, stripCommentsPreservingStrings } from "./_shared.js";

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
	for (const m of src.matchAll(re)) {
		const matchIdx = m.index ?? 0;
		const openIdx = matchIdx + m[0].length - 1;
		// Skip control-flow constructs whose `) {` looks like a function start.
		if (m[1] === ")") {
			const before = src.slice(Math.max(0, matchIdx - 32), matchIdx);
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

// Upper bound on how far `sliceBalancedParens` will scan from the opening
// paren when searching for its match. Most call expressions close within a
// few hundred characters; the bound exists to keep the scan O(maxLen) on
// pathologically long single-line code rather than O(file).
const BALANCED_PARENS_MAX_SCAN = 2000;

/**
 * Walk forward from the position of an opening `(` and return the substring
 * between the parens, balanced. Returns null if the call doesn't close within
 * `maxLen` characters or runs to EOF unmatched.
 */
function sliceBalancedParens(
	src: string,
	openIdx: number,
	maxLen = BALANCED_PARENS_MAX_SCAN,
): string | null {
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
		if (matches.length >= 10) break;
		const stripLine = strippedLines[i];
		if (!callRe.test(stripLine)) continue;
		// Skip lines that look like a relative-path string assignment intent —
		// those were stripped to `""`, so an empty arg slot won't match here.
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}

// Local JS/TS extension predicate for checkUncheckedRedirect — kept inline so
// the broader `isJsTsFile` extension list (which includes `.mts`/`.cts`) is
// not coupled into this module's gate; the original used `isJsTsFile`.
function isJsTsExt(ext: string): boolean {
	return (
		ext === ".ts" ||
		ext === ".tsx" ||
		ext === ".js" ||
		ext === ".jsx" ||
		ext === ".mjs" ||
		ext === ".cjs" ||
		ext === ".mts" ||
		ext === ".cts"
	);
}

/**
 * `ubs_document_write` — `document.write(...)` / `document.writeln(...)` is an
 * XSS sink and a render-blocking anti-pattern. No legitimate use in modern
 * code; the safe alternatives are `textContent` or DOM construction with
 * `createElement` / `appendChild`. pre_warn / warning.
 */
export function checkDocumentWrite(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isJsTsExt(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const re = /\bdocument\s*\.\s*write(?:ln)?\s*\(/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		if (!re.test(strippedLines[i])) continue;
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_outer_html_assignment` — `<expr>.outerHTML = <value>`. Equivalent XSS
 * sink to `.innerHTML =` (which `checkInnerHtmlUsage` already covers); kept
 * separate because the safe-alternative guidance differs (`outerHTML` replaces
 * the element itself, so `replaceWith(textNode)` is the textContent analog).
 * pre_warn / warning.
 */
export function checkOuterHtmlAssignment(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isJsTsExt(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const re = /\.outerHTML\s*=/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		if (!re.test(strippedLines[i])) continue;
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_insert_adjacent_html` — `.insertAdjacentHTML(position, htmlString)`
 * parses the second arg as HTML and is an XSS sink whenever any part of the
 * string is attacker-controlled. Safe alternative is `insertAdjacentText`
 * for text, or `insertAdjacentElement` with a DOM-constructed node.
 * pre_warn / warning.
 */
export function checkInsertAdjacentHtml(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isJsTsExt(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const re = /\.insertAdjacentHTML\s*\(/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		if (!re.test(strippedLines[i])) continue;
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_node_create_cipher` — Node `crypto.createCipher(...)` /
 * `createDecipher(...)` derive the key via an MD5-based KDF with no IV. The
 * function was removed entirely in Node 22; pre-22 code using it has a
 * predictable key schedule. `createCipheriv` / `createDecipheriv` with a
 * random IV is the safe replacement. pre_warn / error.
 *
 * Negative lookahead excludes the `iv`-suffixed safe forms. Matches both the
 * `crypto.createCipher(...)` and bare-destructured `createCipher(...)` shapes.
 */
export function checkNodeCreateCipher(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isJsTsExt(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	// Node API casing is inconsistent: `createCipher` (capital C) but
	// `createDecipher` (capital D, lowercase c). Spell both branches out so
	// the regex catches all four legacy variants while the `(?!iv)` negative
	// lookahead excludes the safe `createCipheriv` / `createDecipheriv`
	// forms. Matches both `crypto.create*(...)` and bare-destructured
	// `create*(...)` shapes.
	const re = /\bcreate(?:Cipher|Decipher)(?!iv)\s*\(/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		if (!re.test(strippedLines[i])) continue;
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_script_without_sri` — `<script src="https://..."></script>` with an
 * external URL but no `integrity="sha..."` attribute. If the CDN is
 * compromised or substituted, the loaded code executes with full page
 * privileges. SRI ties the script content to a known hash so a swapped file
 * fails to load instead of silently executing.
 *
 * Scans HTML and JSX/TSX/Vue/Svelte sources. Markdown is intentionally
 * skipped — documentation routinely shows unsafe examples for illustration.
 * pre_warn / warning.
 */
export function checkScriptWithoutSri(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const isHtml = ext === ".html" || ext === ".htm";
	const isJsxLike =
		ext === ".jsx" || ext === ".tsx" || ext === ".vue" || ext === ".svelte" || ext === ".astro";
	if (!isHtml && !isJsxLike) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	// Match an entire `<script ...>` opening tag. The negative-lookahead window
	// requires that NO `integrity=` attribute appears before the closing `>`.
	// `src=` must reference an absolute external URL (`//` or `http(s)?://`).
	// Bounded character runs (400 / 300 chars) keep the regex linear-time.
	const re =
		/<script\s+(?![^>]{0,400}\bintegrity\s*=)[^>]{0,200}\bsrc\s*=\s*["'](?:https?:)?\/\/[^"']{1,300}["'][^>]{0,100}>/gi;

	for (const m of content.matchAll(re)) {
		if (matches.length >= 10) break;
		const idx = m.index ?? 0;
		const lineNum = content.slice(0, idx).split("\n").length;
		matches.push({ line: lineNum, text: originalLines[lineNum - 1].trim().slice(0, 150) });
	}
	return matches;
}
