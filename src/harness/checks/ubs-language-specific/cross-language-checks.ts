// UBS language-specific detectors — cross-language checks. Extracted from
// ubs-language-specific.ts during the 1500-line decomposition. Each function
// returns InlineMatch[]. Multi-language; ext-gated per check.

import { stripRegexLiterals } from "../../strip-helpers.js";
import { getExtension, type InlineMatch, isTestFile } from "../shared.js";
import { MATCH_LIMIT, stripCommentsPreservingStrings } from "./_shared.js";

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
		ext === ".rs" ||
		ext === ".swift";
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
	// JS/Py/Go/Rust: `"…" + ident` or `` `…${expr}…` ``.
	// Swift: `"…\(ident)…"` — Swift's string interpolation uses `\(expr)`.
	const interpolation =
		/["'`].*[+,]\s*[A-Za-z_$]\w*|`[^`]*\$\{[^}]*\}[^`]*`|"[^"]*\\\([^)]+\)/;

	// Helicone audit (2026-05): the check was firing 66 times on
	// `WHERE id = $1` style PARAMETERIZED queries — the `$N` placeholder
	// IS the safe form. Same for `?` (positional) and `:name` (named).
	// Skip any line that contains a recognizable parameterized-query
	// placeholder, regardless of what follows it.
	//
	// The `?` placeholder accepts any closing context (whitespace, comma,
	// `)`, `"`, `'`) so Swift / Java forms like `"WHERE id = ?"` are
	// recognized as parameterized — the placeholder sits at the END of
	// the string literal, immediately followed by the closing quote.
	const placeholder = /\$\d+\b|[=(,\s]\?[\s,)"']|:\w+\b/;
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
 * `sql_escape_hatch_non_literal` — SQL libraries expose a single "unsafe"
 * escape hatch reserved for compile-time constants (Effect's `sql.unsafe`,
 * Drizzle's `sql.raw`, Kysely's `sql.lit`). Passing a runtime expression
 * into it almost always means a SQL-injection vector — bypasses the
 * library's parameterization guarantee for a value that should have been
 * a parameter.
 *
 * Effect-TS lessons port (docs/design/effect-ts-harness-additions.md §2.6).
 *
 * Flags: `sql.unsafe(`/`sql.raw(`/`sql.lit(` whose first argument is NOT a
 * string literal (single quote, double quote, or template literal opening
 * backtick) or a recognized literal-template-tag pattern.
 *
 * Skips: test files, non-JS/TS files.
 */
const SQL_ESCAPE_HATCH_RE = /\b(?:sql|db|orm)\.(?:unsafe|raw|lit)\s*\(\s*/g;

export function checkSqlEscapeHatchNonLiteral(
	content: string,
	filePath: string,
): InlineMatch[] {
	const ext = getExtension(filePath);
	const isCode =
		ext === ".ts" ||
		ext === ".tsx" ||
		ext === ".js" ||
		ext === ".jsx" ||
		ext === ".mjs" ||
		ext === ".cjs" ||
		ext === ".mts" ||
		ext === ".cts";
	if (!isCode) return [];
	if (isTestFile(filePath)) return [];

	// Strip comments only — preserve string contents so we can read the
	// character right after the opening paren and decide literal-vs-not.
	const stripped = stripCommentsPreservingStrings(content);
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const re = new RegExp(SQL_ESCAPE_HATCH_RE.source, "g");
	let m: RegExpExecArray | null = re.exec(stripped);
	while (m !== null) {
		if (matches.length >= MATCH_LIMIT) break;
		// The match ends right at the first non-whitespace position after `(`.
		const firstChar = stripped[m.index + m[0].length];
		const isLiteralOpen =
			firstChar === '"' || firstChar === "'" || firstChar === "`";
		if (!isLiteralOpen) {
			const lineNum = stripped.slice(0, m.index).split("\n").length;
			matches.push({
				line: lineNum,
				text: `SQL escape hatch (${m[0].trim()}) called with non-literal argument — should only wrap compile-time constants (schema names, etc.): ${(originalLines[lineNum - 1] ?? "").trim().slice(0, 120)}`,
			});
		}
		m = re.exec(stripped);
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
	// `new RegExp(...)` and `RegExp(...)` invocations are by construction
	// pattern-matchers, not endpoint configs. The detector that finds
	// curl-to-localhost calls in agent commands necessarily contains the
	// literal "localhost" inside the regex source (template string passed
	// to RegExp). Exempting RegExp constructors avoids the self-FP without
	// missing real bugs — a real bug uses fetch("http://localhost:3000")
	// or axios.get(...), not RegExp("...localhost...").
	const regExpConstructor = /\bRegExp\s*\(/;
	// Pattern-building exemption (narrowed). The previous blanket "any
	// interpolated template containing localhost" rule was too broad: it
	// hid real production endpoints like `fetch(\`http://localhost:${port}/api\`)`.
	// Tightened to fire only when the template literal also carries a
	// regex-shape signal (regex metacharacters or a pattern-named target):
	//   - assigned/declared as `*_RE`, `*Re`, `*Pattern`, `*Regex`
	//   - contains common regex metacharacters or escape sequences
	//   - argument to a regex method: `.test(`, `.match(`, `.replace(`, `.exec(`, `.search(`
	// Lines without those signals fall through to the matcher, so a real
	// localhost URL inside an interpolated template (real bug) is flagged.
	const localhostInsideTemplate = /`[^`]*\b(?:localhost|127\.0\.0\.1)\b[^`]*`/;
	const looksLikeRegexPattern =
		// eslint-disable-next-line no-template-curly-in-string -- regex source intentionally contains `${` as a literal metachar pattern, not a template placeholder
		/(?:[A-Z][A-Za-z0-9_]*_RE\b|[A-Za-z][A-Za-z0-9_]*(?:Re|Pattern|Regex)\b\s*=)|\\(?:b|d|s|w|S|D|W|B|n|r|t)\b|\[\^?\\?[a-zA-Z0-9]|\(\?:|\.\s*(?:test|match|replace|exec|search)\s*\(/;
	// A localhost literal that is a *configurable default* or a *detection
	// test* is not a baked endpoint — it is exactly the shape this check's own
	// fix_instruction endorses ("a clear default for local dev"). Without these
	// exemptions the check FP'd on `interlinked enable`/`init`, where the CLI's
	// documented localhost dev-server default is correct. Three legitimate forms:
	//   1. fallback default after `||` / `??`  — `flag || "http://localhost:8787"`
	const localhostAsDefault = /(?:\|\||\?\?)\s*["'`][^"'`]*(?:localhost|127\.0\.0\.1)/;
	//   2. membership / equality test  — `url.includes("localhost")`, `h === "localhost"`
	const localhostAsTest =
		/(?:\.(?:includes|indexOf|startsWith|endsWith|search|match)\s*\(|[=!]==?)\s*["'`][^"'`]*(?:localhost|127\.0\.0\.1)/;
	//   3. a default-/fallback-named declaration  — `const DEFAULT_SERVER = "...localhost"`
	const localhostNamedDefault = /\b(?:const|let|var)\s+\w*(?:default|fallback)\w*\s*=/i;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		if (!re.test(strippedLines[i])) continue;
		if (metadataAssignment.test(strippedLines[i])) continue;
		if (regExpConstructor.test(strippedLines[i])) continue;
		// Configurable-default / detection-test shapes (see the three regexes
		// above) are not baked endpoints — the override path already exists.
		if (
			localhostAsDefault.test(strippedLines[i]) ||
			localhostAsTest.test(strippedLines[i]) ||
			localhostNamedDefault.test(strippedLines[i])
		) {
			continue;
		}
		// Multi-line RegExp: the constructor is on one line and the literal
		// argument is on the next. Skip when the previous non-empty line
		// ends with `RegExp(` (its argument continuation).
		let prev = i - 1;
		while (prev >= 0 && strippedLines[prev].trim() === "") prev--;
		if (prev >= 0 && /\bRegExp\s*\(\s*$/.test(strippedLines[prev])) continue;
		// Narrowed template-literal exemption: only skip when there's a
		// pattern-building signal alongside the interpolated localhost.
		if (
			localhostInsideTemplate.test(originalLines[i]) &&
			looksLikeRegexPattern.test(originalLines[i])
		) {
			continue;
		}
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}
