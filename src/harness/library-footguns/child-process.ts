// ============================================================
// child_process shell-injection footgun detectors
// ============================================================
// Highest-severity Node bug class: `exec()` / `execSync()` with
// any interpolated user input spawns a shell, and shell
// interpolation runs anything that contains shell metacharacters
// (`;`, `&&`, backticks, etc.). The argv-array form via
// `spawn()` / `execFile()` is the safe alternative.

import { getExtension, type InlineMatch, isGeneratedFile, isTestFile, JS_TS_EXTS } from "../checks/shared.js";
import type { LibraryFootgunCheck } from "./types.js";

// Match `exec(` / `execSync(` whose argument starts with a
// template literal containing `${...}` OR a string + concat.
// Negative lookbehind on `.|\w` so `obj.execMethod(` doesn't match.
const EXEC_INTERPOLATED_RE =
	/(?<![.\w$])exec(?:Sync)?\s*\(\s*(?:`[^`]*\$\{|["'][^"']*["']\s*\+|\w+\s*\+)/g;

function shouldSkip(filePath: string, content: string): boolean {
	const ext = getExtension(filePath);
	if (!JS_TS_EXTS.has(ext)) return true;
	if (isTestFile(filePath)) return true;
	if (isGeneratedFile(content)) return true;
	return false;
}

function detectExecInterpolated(content: string, filePath: string): InlineMatch[] {
	if (shouldSkip(filePath, content)) return [];
	const out: InlineMatch[] = [];
	const lines = content.split("\n");
	EXEC_INTERPOLATED_RE.lastIndex = 0;
	let m: RegExpExecArray | null = EXEC_INTERPOLATED_RE.exec(content);
	while (m !== null) {
		const lineNo = content.slice(0, m.index).split("\n").length;
		out.push({
			line: lineNo,
			text: (lines[lineNo - 1] || "").trim().slice(0, 150),
		});
		m = EXEC_INTERPOLATED_RE.exec(content);
	}
	return out;
}

export const CHILD_PROCESS_FOOTGUNS: LibraryFootgunCheck[] = [
	{
		id: "child_process_exec_interpolated",
		name: "child_process exec with interpolated input",
		library: "child-process",
		detect: detectExecInterpolated,
		fixInstruction:
			"`exec(`cmd ${userInput}`)` and `exec('cmd ' + userInput)` spawn a SHELL that interprets metacharacters. A `;` or backtick in `userInput` runs arbitrary code. Switch to the argv-array form: `spawn('cmd', [userInput])` or `execFile('cmd', [userInput])` — these bypass the shell entirely. If you genuinely need shell features, validate/escape the input explicitly before interpolation.",
	},
];
