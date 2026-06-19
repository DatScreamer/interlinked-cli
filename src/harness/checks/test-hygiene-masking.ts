// interlinked-tdd: exempt
// ===========================================
// Comment/string masking — pure char-level helpers extracted from
// test-hygiene-quality.ts to keep that module under the per-file line cap.
// ===========================================
// These blank out comments and string literals (preserving offsets + newlines)
// so the test-hygiene checks can tell executable code from text. Pure functions
// over a char array — no project imports, no state. Tested end-to-end through
// `checkHappyPathOnlyTest` in test-hygiene.test.ts (the public consumer).

type MaskMode = "code" | "line-comment" | "block-comment" | "single" | "double" | "template";

/** One scan step's outcome: the mode for the next char, and whether a lookahead
 *  char was already consumed (so the caller advances its index by one more). */
interface MaskStep {
	mode: MaskMode;
	advanced: boolean;
}

/** Inside `// …`: blank everything until the newline, which ends the comment
 *  (the newline itself stays, preserving offsets and line counts). */
function maskLineCommentChar(chars: string[], i: number, ch: string): MaskStep {
	if (ch === "\n") return { mode: "code", advanced: false };
	chars[i] = " ";
	return { mode: "line-comment", advanced: false };
}

/** Inside a block comment: blank the char (keeping newlines); on the closing
 *  `*​/` blank both chars and return to code. `ch` is the original char at `i`. */
function maskBlockCommentChar(chars: string[], i: number, ch: string, next: string | undefined): MaskStep {
	chars[i] = ch === "\n" ? "\n" : " ";
	if (ch === "*" && next === "/") {
		chars[i + 1] = " ";
		return { mode: "code", advanced: true };
	}
	return { mode: "block-comment", advanced: false };
}

/** True when `ch` closes the currently-open string literal of `mode`. */
function closesStringMode(mode: MaskMode, ch: string): boolean {
	if (mode === "single") return ch === "'";
	if (mode === "double") return ch === '"';
	return mode === "template" && ch === "`";
}

/** Inside a string literal: blank the char, honour a backslash escape (blank the
 *  escaped char too), and close on the matching quote. `mode` is a string mode. */
function maskStringChar(
	chars: string[],
	i: number,
	ch: string,
	next: string | undefined,
	mode: MaskMode,
): MaskStep {
	chars[i] = ch === "\n" ? "\n" : " ";
	if (ch === "\\") {
		if (next === undefined) return { mode, advanced: false };
		chars[i + 1] = next === "\n" ? "\n" : " ";
		return { mode, advanced: true };
	}
	if (closesStringMode(mode, ch)) return { mode: "code", advanced: false };
	return { mode, advanced: false };
}

/** In code mode: detect the start of a comment or string literal, blanking its
 *  opener and returning the new mode. Plain code chars are left untouched. */
function enterModeFromCode(
	chars: string[],
	i: number,
	ch: string,
	next: string | undefined,
): MaskStep {
	if (ch === "/" && (next === "/" || next === "*")) {
		chars[i] = " ";
		chars[i + 1] = " ";
		return { mode: next === "/" ? "line-comment" : "block-comment", advanced: true };
	}
	if (ch === "'" || ch === '"' || ch === "`") {
		chars[i] = " ";
		const opened: MaskMode = ch === "'" ? "single" : ch === '"' ? "double" : "template";
		return { mode: opened, advanced: false };
	}
	return { mode: "code", advanced: false };
}

/** Dispatch one character to the handler for the current `mode`. */
function maskStep(
	chars: string[],
	i: number,
	ch: string,
	next: string | undefined,
	mode: MaskMode,
): MaskStep {
	if (mode === "line-comment") return maskLineCommentChar(chars, i, ch);
	if (mode === "block-comment") return maskBlockCommentChar(chars, i, ch, next);
	if (mode === "single" || mode === "double" || mode === "template") {
		return maskStringChar(chars, i, ch, next, mode);
	}
	return enterModeFromCode(chars, i, ch, next);
}

/** Blank every comment and string literal in `content`, preserving length,
 *  newlines, and byte offsets so a match index can be tested against code. */
export function maskCommentsAndStrings(content: string): string {
	const chars = content.split("");
	let mode: MaskMode = "code";
	for (let i = 0; i < chars.length; i++) {
		const step = maskStep(chars, i, chars[i], chars[i + 1], mode);
		mode = step.mode;
		if (step.advanced) i++;
	}
	return chars.join("");
}

/** True when the char at `offset` in masked content is real code (non-blank). */
export function isCodeMatch(maskedContent: string, offset: number): boolean {
	return /\S/.test(maskedContent[offset] ?? "");
}

/** True when a `describe`/`it`/`test` call text is a `.skip`/`.todo` variant. */
export function isSkippedOrTodoCall(matchText: string): boolean {
	const head = matchText.slice(0, Math.max(0, matchText.indexOf("(")));
	return /\.(?:skip|todo)\b/.test(head);
}

/** Blank `chars[start..end)` in place, preserving newlines. */
export function blankRange(chars: string[], start: number, end: number): void {
	for (let i = start; i < Math.min(end, chars.length); i++) {
		chars[i] = chars[i] === "\n" ? "\n" : " ";
	}
}
