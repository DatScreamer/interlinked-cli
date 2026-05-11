// ============================================================
// Cloudflare D1 footgun detectors
// ============================================================
// SQL-injection class: `env.DB.exec(string)` with interpolated
// user input is one of the highest-severity Workers bugs.
// The safe form is `db.prepare(literal).bind(params).run()`.

import { getExtension, type InlineMatch, isGeneratedFile, isTestFile, JS_TS_EXTS } from "../checks/shared.js";
import type { LibraryFootgunCheck } from "./types.js";

// Match `<binding>.exec(...)` where the argument is a template literal
// with `${...}` interpolation, or a string with `+` concat.
const D1_EXEC_INTERPOLATED_RE =
	/\b(?:DB|D1|env\.\w+|env\[[^\]]+\])\s*\.\s*exec\s*\(\s*(`[^`]*\$\{[^`]*`|"[^"]*"\s*\+|'[^']*'\s*\+)/g;

function shouldSkip(filePath: string, content: string): boolean {
	const ext = getExtension(filePath);
	if (!JS_TS_EXTS.has(ext)) return true;
	if (isTestFile(filePath)) return true;
	if (isGeneratedFile(content)) return true;
	return false;
}

function detectExecStringConcat(content: string, filePath: string): InlineMatch[] {
	if (shouldSkip(filePath, content)) return [];
	const out: InlineMatch[] = [];
	const lines = content.split("\n");
	D1_EXEC_INTERPOLATED_RE.lastIndex = 0;
	let m: RegExpExecArray | null = D1_EXEC_INTERPOLATED_RE.exec(content);
	while (m !== null) {
		const lineNo = content.slice(0, m.index).split("\n").length;
		out.push({
			line: lineNo,
			text: (lines[lineNo - 1] || "").trim().slice(0, 150),
		});
		m = D1_EXEC_INTERPOLATED_RE.exec(content);
	}
	return out;
}

export const D1_FOOTGUNS: LibraryFootgunCheck[] = [
	{
		id: "d1_exec_string_concat",
		name: "D1 exec() with interpolated SQL",
		library: "d1",
		detect: detectExecStringConcat,
		fixInstruction:
			"`db.exec(`...${userInput}...`)` is SQL injection. Use the prepared-statement form: `await db.prepare('SELECT * FROM x WHERE id = ?').bind(userInput).run()`. The `?` placeholder + `.bind()` keeps SQL and data separate.",
	},
];
