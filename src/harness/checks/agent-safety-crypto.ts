// Agent Safety Checks — Cross-language crypto / TLS / filesystem safety.
// Deterministic regex/heuristic checks targeting common AI agent mistakes.
// Extracted from agent-safety.ts to stay under the per-file line ceiling.

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_EXTS,
	stripComments,
	stripCommentsAndStrings,
} from "./shared.js";
import { nonNull } from "../../lib/non-null.js";

// ===========================================
// Row 24 — `ubs_tls_verify_disabled` (cross-language)
// ===========================================

/**
 * Detect TLS verification disabled across languages.
 *
 * Catches the common Python (`requests` / `httpx` / stdlib `ssl`), Go
 * (`tls.Config{}`), and Node (`https.request` / `tls.connect` / env var)
 * idioms for turning off the TLS peer-cert check. Each is a man-in-the-middle
 * vector unless the call sits behind a controlled proxy with a documented
 * justification.
 *
 * Shapes covered:
 *   - `verify=False`                          (Python requests / httpx)
 *   - `InsecureSkipVerify: true`              (Go crypto/tls)
 *   - `rejectUnauthorized: false`             (Node https / tls)
 *   - `NODE_TLS_REJECT_UNAUTHORIZED=0`        (Node env var)
 *   - `ssl._create_unverified_context()`      (Python stdlib bypass)
 *   - `check_hostname=False`                  (Python stdlib / httpx)
 */
export function checkTlsVerifyDisabled(content: string, filePath: string): InlineMatch[] {
	void filePath; // cross-language; no extension gate.
	const stripped = stripCommentsAndStrings(content);
	const commentStripped = stripComments(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const commentStrippedLines = commentStripped.split("\n");

	// Code-level shapes — must NOT fire inside string literals (`const msg =
	// "verify=False is unsafe"` is documentation, not a TLS bypass), so scan
	// the strings-blanked view.
	const codeRe =
		/\bverify\s*=\s*False\b|\bInsecureSkipVerify\s*:\s*true\b|\brejectUnauthorized\s*:\s*false\b|\bssl\._create_unverified_context\b|\bcheck_hostname\s*=\s*False\b/;
	// Node env-var assignment — the value lives in a string literal (`= "0"`),
	// so this shape must scan the comment-only-stripped view (strings preserved)
	// to find the assignment. The env-var name itself is so specific that
	// matching it inside a string is still a real finding (an env var named
	// that with value 0 anywhere in source is a TLS-bypass).
	const envRe = /\bNODE_TLS_REJECT_UNAUTHORIZED\b[\s\S]{0,20}?=\s*["']?0\b/;

	const matches: InlineMatch[] = [];
	const flagged = new Set<number>();
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const fired =
			codeRe.test(strippedLines[i] ?? "") ||
			envRe.test(commentStrippedLines[i] ?? "");
		if (fired && !flagged.has(i)) {
			flagged.add(i);
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
		}
	}
	return matches;
}

// ===========================================
// Row 26 — `ubs_weak_hash` (cross-language)
// ===========================================

/**
 * `ubs_aes_ecb_mode` — AES in ECB mode leaks plaintext structure: identical
 * 16-byte blocks encrypt to identical ciphertext, so an attacker can detect
 * patterns and substitute ciphertext blocks. The safe replacements are GCM
 * (AEAD; integrity + confidentiality) or CBC with a separately-derived HMAC.
 * pre_warn / error.
 *
 * Cross-language shapes:
 *   - Python `pycryptodome`:  `AES.MODE_ECB`
 *   - Python `cryptography`:  `modes.ECB(`
 *   - Node `createCipheriv`:  string `"aes-128-ecb"` / `"aes-256-ecb"` / etc.
 *   - Go `crypto/aes`:        `cipher.NewECBEncrypter` (rare; flag for review)
 *
 * Node algorithm strings live inside literals, so the Node shape needs the
 * comment-stripped (but string-preserving) view rather than the strip-strings
 * pass.
 */
export function checkAesEcbMode(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const commentOnlyStripped = stripComments(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const commentOnlyLines = commentOnlyStripped.split("\n");

	const codeRe = /\bAES\.MODE_ECB\b|\bmodes\.ECB\s*\(|\bcipher\.NewECB(?:En|De)crypter\b/;
	const stringRe = /["'`]aes-\d{2,4}-ecb["'`]/i;

	const matches: InlineMatch[] = [];
	const flagged = new Set<number>();
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const fired =
			codeRe.test(strippedLines[i] ?? "") || stringRe.test(commentOnlyLines[i] ?? "");
		if (fired && !flagged.has(i)) {
			flagged.add(i);
			matches.push({ line: i + 1, text: (originalLines[i] ?? "").trim().slice(0, 150) });
		}
	}
	return matches;
}

/**
 * Detect weak cryptographic hash usage (MD5, SHA-1) across languages.
 *
 * Plan 04 §4.1 regex: `\b(?:md5|sha1)\s*\(` (case-insensitive).
 *
 * Both MD5 and SHA-1 are broken for collision resistance. Acceptable for
 * non-security checksums (cache keys, file hashing) but fired anywhere a
 * literal call appears so the agent considers the choice. Test files are
 * exempt because checksum fixtures and golden hashes routinely embed MD5
 * outputs.
 */
export function checkWeakHash(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	// Comment-only strip preserves string contents so we can match Node's
	// `crypto.createHash("md5")` form, where the algorithm name lives inside
	// a string literal that `stripCommentsAndStrings` would have blanked.
	// Comments still get blanked so `// createHash("md5") example` doesn't
	// fire a false positive.
	const commentStrippedLines = stripComments(content).split("\n");

	// Form 1: `\b(?:md5|sha1)\s*\(` case-insensitive — catches `md5(buf)`,
	// `MD5(buf)`, `hashlib.md5(...)`, and the Go `md5.New()` / `sha1.New()`
	// forms where the algorithm name is a code identifier.
	const directRe = /\b(?:md5|sha1)\s*\(/i;
	// Form 2: Node `crypto.createHash("md5")` / `createHash('sha1')` /
	// `createHash(\`md5\`)`. The algorithm lives inside a string literal,
	// so this form has to scan a comment-stripped (but string-preserving)
	// view rather than `strippedLines` (which blanks the string contents).
	const createHashRe = /\bcreateHash\s*\(\s*["'`](?:md5|sha1)["'`]/i;

	const matches: InlineMatch[] = [];
	const flagged = new Set<number>();
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const fired =
			directRe.test(strippedLines[i] ?? "") ||
			createHashRe.test(commentStrippedLines[i] ?? "");
		if (fired && !flagged.has(i)) {
			flagged.add(i);
			matches.push({ line: i + 1, text: (originalLines[i] ?? "").trim().slice(0, 150) });
		}
	}
	return matches;
}

type WalkerDecl = { name: string; line: number };

/**
 * Find every function/method declaration in the strings-blanked source, as a
 * `{ name, line }` list. Used by {@link checkRecursiveWalkerLstat} to seed the
 * body scan. Internal helper — recognizes the three declaration shapes
 * (`function f(`, `const f = (`/`function`, and class-method headers) while
 * excluding control-flow keywords from the method form.
 */
function collectWalkerDecls(sLines: string[]): WalkerDecl[] {
	const decls: WalkerDecl[] = [];
	const declRe1 = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/;
	const declRe2 =
		/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\()/;
	const declRe3 =
		/^\s+(?:(?:public|private|protected|static|readonly|override|async)\s+)*(?!(?:if|for|while|switch|catch|do|with|return|new|typeof|throw|delete|void|await|yield)\b)([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{\s*$/;
	for (let i = 0; i < sLines.length; i++) {
		const m1 = nonNull(sLines[i]).match(declRe1);
		if (m1) {
			decls.push({ name: nonNull(m1[1]), line: i });
			continue;
		}
		const m2 = nonNull(sLines[i]).match(declRe2);
		if (m2) {
			decls.push({ name: nonNull(m2[1]), line: i });
			continue;
		}
		const m3 = nonNull(sLines[i]).match(declRe3);
		if (m3) decls.push({ name: nonNull(m3[1]), line: i });
	}
	return decls;
}

/**
 * Locate the byte offset just inside the first `{` at or after `startLine`.
 * Returns the absolute index of the brace, or -1 if no `{` is found before the
 * end of file. `linePrefixLen[i]` is the cumulative byte length of lines `0..i-1`
 * (each terminated by one `\n`), so the returned offset indexes into the joined
 * `stripped` source. Internal helper for {@link checkRecursiveWalkerLstat}.
 */
function findWalkerBodyOpen(
	sLines: string[],
	linePrefixLen: number[],
	startLine: number,
): number {
	for (let i = startLine; i < sLines.length; i++) {
		const idx = nonNull(sLines[i]).indexOf("{");
		if (idx !== -1) return nonNull(linePrefixLen[i]) + idx;
	}
	return -1;
}

/**
 * Given the open-brace offset of a function body in `stripped`, find the
 * matching close-brace offset via depth counting. Returns -1 if unbalanced.
 * Internal helper for {@link checkRecursiveWalkerLstat}.
 */
function findWalkerBodyClose(stripped: string, bodyOpen: number): number {
	let depth = 0;
	for (let i = bodyOpen; i < stripped.length; i++) {
		const c = stripped[i];
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * Decide whether one declaration's body is an unsafe recursive walker and, if
 * so, return the {@link InlineMatch} pointing at its `statSync(` call. Returns
 * `null` when the body is balanced-but-safe or when any of the four conditions
 * fails. Internal helper for {@link checkRecursiveWalkerLstat}; takes the
 * pre-computed `stripped` source plus the body span so the orchestrator stays a
 * thin loop.
 */
function walkerLstatMatch(
	decl: WalkerDecl,
	stripped: string,
	oLines: string[],
	sLines: string[],
	linePrefixLen: number[],
): InlineMatch | null {
	const bodyOpen = findWalkerBodyOpen(sLines, linePrefixLen, decl.line);
	if (bodyOpen < 0) return null;
	const bodyClose = findWalkerBodyClose(stripped, bodyOpen);
	if (bodyClose < 0) return null;
	const body = stripped.slice(bodyOpen + 1, bodyClose);

	if (!/\breaddirSync\s*\(/.test(body)) return null;
	const selfRe = new RegExp("(?:\\bthis\\.)?\\b" + decl.name + "\\b\\s*\\(");
	if (!selfRe.test(body)) return null;
	if (!/\bstatSync\s*\(/.test(body)) return null;
	if (/\blstatSync\s*\(/.test(body)) return null;

	const sm = body.match(/\bstatSync\s*\(/);
	if (!sm || sm.index === undefined) return null;
	const absStat = bodyOpen + 1 + sm.index;
	const lineNum = stripped.slice(0, absStat).split("\n").length;
	return {
		line: lineNum,
		text: (oLines[lineNum - 1] ?? "").trim().slice(0, 150),
	};
}

/**
 * Detect recursive directory walkers that gate recursion on `statSync(...)`
 * instead of `lstatSync(...)`. Without lstat, the walker follows symlinks —
 * leaving the project tree, or looping indefinitely on a cycle.
 *
 * A function fires this check when ALL hold inside its body:
 *   1. calls `readdirSync(...)`             (it is listing a directory)
 *   2. calls itself or `this.<name>(...)`   (it recurses)
 *   3. calls `statSync(...)`                (the unsafe stat)
 *   4. does NOT also call `lstatSync(...)`  (no symlink awareness)
 */
export function checkRecursiveWalkerLstat(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];
	if (!/\bstatSync\s*\(/.test(content)) return [];
	if (!/\breaddirSync\s*\(/.test(content)) return [];

	const stripped = stripCommentsAndStrings(content);
	const sLines = stripped.split("\n");
	const oLines = content.split("\n");

	const linePrefixLen: number[] = [0];
	for (const ln of sLines) {
		linePrefixLen.push(nonNull(linePrefixLen[linePrefixLen.length - 1]) + ln.length + 1);
	}

	const decls = collectWalkerDecls(sLines);

	const matches: InlineMatch[] = [];
	for (const d of decls) {
		if (matches.length >= 10) break;
		const m = walkerLstatMatch(d, stripped, oLines, sLines, linePrefixLen);
		if (m) matches.push(m);
	}
	return matches;
}
