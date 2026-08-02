// Cross-language checks (SQL injection).
// Extracted from generic-checks.ts.

import { nonNull } from "../../lib/non-null.js";
import { getExtension, type InlineMatch, stripComments } from "./shared.js";

// ===========================================
// Cross-Language Checks
// ===========================================

const JS_FAMILY_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** JS/TS template-literal interpolation shapes unlikely to be SQL injection:
 * schema introspection, DDL with code-controlled identifiers, SQL-fragment
 * helper calls, quoted identifiers, dynamic column lists, and simple
 * table/column-name interpolation. */
function isSafeJsTemplateInterpolation(line: string): boolean {
	// PRAGMA statements (schema introspection, never user data)
	if (/\bPRAGMA\s/i.test(line)) return true;
	// DDL statements with code-controlled identifiers
	if (/\b(ALTER|DROP|CREATE)\s+(TABLE|INDEX|TRIGGER)\b/i.test(line)) return true;
	// SQL fragment helper functions (e.g., ARCHIVED_FILTER(), VISIBLE_PROJECT_FILTER())
	if (/\$\{\s*[A-Z][A-Z_]*\s*\(/.test(line)) return true;
	// Double-quoted identifier interpolation ("${tableName}")
	if (/"\$\{[^}]+\}"/.test(line)) return true;
	// Dynamic column building via .join() (column names from code, values use ?)
	if (/\$\{[^}]*\.join\s*\(/.test(line)) return true;
	// FTS rebuild command pattern
	if (/VALUES\s*\(\s*'rebuild'\s*\)/i.test(line)) return true;
	// Simple identifier interpolation referencing table/column names from code
	if (/\$\{\s*\w*(table|column|tbl|col|idx|spec)\w*\s*\}/i.test(line)) return true;
	return false;
}

/** Swift: SQLite.swift / GRDB / Core Data — `.execute`/`.run`/`.prepare`/`.query`
 * or `NSPredicate(format:)` called with a Swift-interpolated string `"...\(v)..."`.
 * The safe form uses `?`/`$1` placeholders with a binding array, or `%@` for
 * NSPredicate. */
function isSwiftInterpolationSink(line: string): boolean {
	if (
		/\.(?:execute|run|prepare|query|fetch)\s*\(\s*(?:sql\s*:\s*)?"[^"]*\\\([^)]+\)/.test(line)
	) {
		return true;
	}
	return /\bNSPredicate\s*\(\s*format\s*:\s*"[^"]*\\\([^)]+\)/.test(line);
}

/** Whether one comment-stripped line looks like a SQL-injection sink for `ext`.
 * Checked in order, each exclusive of the rest (a branch that matches never
 * falls through to a later one, even when it turns out to be a safe
 * pattern): JS/TS template-literal interpolation, Python f-string execute
 * calls, Swift interpolation sinks, then a generic string-concatenation sink
 * that applies regardless of extension. */
function isSqlInjectionLine(line: string, ext: string): boolean {
	if (
		JS_FAMILY_EXTS.includes(ext) &&
		/\.(query|execute|raw|prepare|exec)\s*\(\s*`[^`]*\$\{/.test(line)
	) {
		return !isSafeJsTemplateInterpolation(line);
	}
	if (ext === ".py" && /\.(execute|executemany)\s*\(\s*f["']/.test(line)) {
		return true;
	}
	if (ext === ".swift" && isSwiftInterpolationSink(line)) {
		return true;
	}
	return /\.(query|execute)\s*\(\s*["'][^"']*["']\s*\+/.test(line);
}

/** Detect SQL injection — string interpolation in query/execute calls. */
export function checkSqlInjection(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const stripped = stripComments(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(strippedLines[i]);
		if (isSqlInjectionLine(line, ext)) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
		}
	}
	return matches;
}
