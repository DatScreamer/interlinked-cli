// ===========================================
// Test-block structure extraction (JS/TS)
// ===========================================
// Shared scaffolding for test-hygiene checks that must tie EVIDENCE to the
// specific test it belongs to instead of trusting the whole file — the
// file-wide-suppression bug class: one test's `.skipIf` must not vouch for an
// unrelated sibling, and a token in a comment or fixture string must not
// count as a gate (review finding 2026-06 on the test-portability family).
//
// Callers pass MASKED lines — the output of `stripAllLiterals` — so titles,
// fixture strings, template bodies, comments, and regex literals can never
// fake (or hide) a block boundary or a gate modifier. String/template
// DELIMITERS survive that strip, which is what start detection keys on: a
// real callsite still reads `it('   ', () => {` after masking, while the
// same text inside a fixture is blanked entirely.
//
// Spans come from walking the CALL's parenthesis balance, not from brace
// hunting: an expression-bodied callback (`it('x', () => expect(y).toBe(1))`)
// has no `{`, and balancing against the next `{` in the file assigned a LATER
// test's closing brace to this block — the swallowed sibling then inherited
// this block's `.skipIf` gate (second review round, 2026-06). The call's own
// closing paren bounds every form: brace-bodied, expression-bodied, and
// body-less (`it.todo('…')`).
//
// Deliberately shape-based, not a parser. Starts are anchored at line starts
// (same trade-off as taste-checks-shared's TEST_BLOCK_START). Blocks whose
// title is not a string literal (`describe(name, fn)`, `it.each(table)(...)`)
// are not extracted — callers must treat "no block found" as "fall back to
// file-level evidence", so a missed block degrades to coarser scoping, never
// a wrong association.

import { findBlockEnd } from "../taste-checks-shared.js";

export interface TestBlock {
	/** `it`/`test`/`specify` → "test"; `describe`/`suite`/`context` → "suite". */
	kind: "test" | "suite";
	/** 0-based line of the callsite. */
	startLine: number;
	/** 0-based line of the call's closing paren — the full extent of the
	 *  callsite including any callback body. === startLine for single-line
	 *  calls and body-less calls (`it.todo('…')`). */
	endLine: number;
	/** The chain carries `.skip` / `.todo` / `.fails` — the case never runs,
	 *  so narration about it is acknowledged regardless of any condition. */
	unconditionalGate: boolean;
	/** Raw (masked) argument text of each `.skipIf` / `.runIf` /
	 *  `.skipUnless` modifier on the chain. Callers decide what a condition
	 *  must reference for the gate to count as evidence — see gatedByChain. */
	gateConditions: string[];
	/** Index of the innermost enclosing block in the returned array, or -1. */
	parent: number;
}

/** Cheap first-line gate: the callee must begin ON this line, so a window
 *  match can't re-detect a block that actually starts on a later line. */
const CALLEE_ON_LINE_RE = /^\s*(?:it|test|specify|describe|suite|context)\s*[.(]/;

/** Full start match over a small multi-line window: callee, optional modifier
 *  chain (modifier args allow one nesting level), then a string-literal title.
 *  Group 1 = callee, group 2 = modifier chain text (title excluded, so gate
 *  detection on it cannot be spoofed by title content). */
const BLOCK_START_RE =
	/^\s*(it|test|specify|describe|suite|context)\s*((?:\.\s*\w+\s*(?:\([^()]*(?:\([^()]*\)[^()]*)*\))?\s*)*)\(\s*["'`]/;

/** Conditional gate modifiers: capture the argument text so callers can
 *  test WHAT the gate conditions on (an unrelated `.skipIf(!dockerAvailable)`
 *  must not pass for platform evidence). Runs only on the modifier-chain
 *  capture, never on titles or bodies. */
const CONDITIONAL_GATE_RE = /\.\s*(?:skipIf|skipUnless|runIf)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;

/** Unconditional non-run markers. `\b` is safe against `.skipIf` because
 *  `skip` → `I` is a word→word position (no boundary). */
const UNCONDITIONAL_GATE_RE = /\.\s*(?:skip|todo|fails)\b/;

/** Lines of masked source joined when matching a single block start —
 *  covers `it.skipIf(\n  cond\n)('title', …` style formatting. Sized to the
 *  same 8-line header budget as taste-checks' TEST_NAME_HEADER_LINES: a
 *  3-line window missed a formatted multi-condition `.skipIf` whose title
 *  lands on the fourth line, so guards inside that callback read as
 *  outside-any-test and the silent-skip check went blind to them (review
 *  round 5). */
const START_WINDOW_LINES = 8;

/** End line of the call whose argument list opens at `openParen`: walk the
 *  paren balance to the matching close, counting newlines. Returns null when
 *  the parens never balance (pathological masked input) — callers fall back
 *  to brace-based findBlockEnd, the older, coarser bound. */
function callExtentEndLine(masked: string, openParen: number, startLine: number): number | null {
	let depth = 0;
	let line = startLine;
	for (let k = openParen; k < masked.length; k++) {
		const c = masked[k];
		if (c === "\n") line++;
		else if (c === "(") depth++;
		else if (c === ")") {
			depth--;
			if (depth === 0) return line;
		}
	}
	return null;
}

function gateConditionsOf(chain: string): string[] {
	const conditions: string[] = [];
	for (const m of chain.matchAll(CONDITIONAL_GATE_RE)) {
		const cond = m[1].trim();
		if (cond.length > 0) conditions.push(cond);
	}
	return conditions;
}

/**
 * Extract every string-titled test/suite callsite from masked source lines,
 * with call extents, gate info, and parent containment. `mLines` MUST be
 * `stripAllLiterals(content).split("\n")` — feeding raw source here
 * reintroduces the fixture-as-code FP class this module exists to prevent.
 */
export function extractTestBlocks(mLines: string[]): TestBlock[] {
	const lineStart: number[] = [];
	let acc = 0;
	for (const l of mLines) {
		lineStart.push(acc);
		acc += l.length + 1;
	}
	const masked = mLines.join("\n");

	const blocks: TestBlock[] = [];
	for (let i = 0; i < mLines.length; i++) {
		if (!CALLEE_ON_LINE_RE.test(mLines[i])) continue;
		const window = mLines.slice(i, i + START_WINDOW_LINES).join("\n");
		const m = BLOCK_START_RE.exec(window);
		if (!m) continue;
		// The title-opening paren is the last `(` in the match (the match ends
		// with `(\s*<quote>`, and nothing after that paren can contain one).
		// The match can span window lines, so the paren's own line is
		// startLine plus the newlines consumed before it.
		const parenInWindow = m[0].lastIndexOf("(");
		const openParen = lineStart[i] + parenInWindow;
		const parenLine = i + (m[0].slice(0, parenInWindow).match(/\n/g) ?? []).length;
		const endLine =
			callExtentEndLine(masked, openParen, parenLine) ?? Math.max(i, findBlockEnd(mLines, i));
		const chain = m[2] ?? "";
		blocks.push({
			kind: m[1] === "describe" || m[1] === "suite" || m[1] === "context" ? "suite" : "test",
			startLine: i,
			endLine,
			unconditionalGate: UNCONDITIONAL_GATE_RE.test(chain),
			gateConditions: gateConditionsOf(chain),
			parent: -1,
		});
	}

	const stack: number[] = [];
	for (let b = 0; b < blocks.length; b++) {
		while (stack.length > 0 && blocks[stack[stack.length - 1]].endLine < blocks[b].startLine) {
			stack.pop();
		}
		blocks[b].parent = stack.length > 0 ? stack[stack.length - 1] : -1;
		stack.push(b);
	}
	return blocks;
}

/** Index of the innermost block whose span contains `line` (0-based), or -1.
 *  Ties prefer the later (deeper) block. */
export function innermostBlockAt(blocks: TestBlock[], line: number): number {
	let best = -1;
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i];
		if (b.startLine > line || line > b.endLine) continue;
		if (best === -1 || b.endLine - b.startLine <= blocks[best].endLine - blocks[best].startLine) {
			best = i;
		}
	}
	return best;
}

/** Index of the first block whose callsite line falls in [fromLine, toLine]
 *  (0-based, inclusive), or -1. The comment-above-test association window. */
export function blockStartingWithin(blocks: TestBlock[], fromLine: number, toLine: number): number {
	for (let i = 0; i < blocks.length; i++) {
		const s = blocks[i].startLine;
		if (s >= fromLine && s <= toLine) return i;
	}
	return -1;
}

/** True when `line` falls inside the callback span of an `it`/`test` block
 *  (directly or via nesting). Module-level helpers and describe-level setup
 *  code are NOT inside a test — an early return there is not a test skip. */
export function inTestBlock(blocks: TestBlock[], line: number): boolean {
	let idx = innermostBlockAt(blocks, line);
	while (idx !== -1) {
		if (blocks[idx].kind === "test") return true;
		idx = blocks[idx].parent;
	}
	return false;
}

/**
 * True when the block or any enclosing ancestor gates its execution — a
 * `describe.skipIf` legitimately vouches for its children; an unrelated
 * sibling never does. `.skip`/`.todo`/`.fails` always gate (the case never
 * runs). For conditional gates (`.skipIf`/`.runIf`/`.skipUnless`) the
 * caller's `conditionGates` predicate decides whether the CONDITION is the
 * right kind of evidence (default: any condition counts).
 */
export function gatedByChain(
	blocks: TestBlock[],
	idx: number,
	conditionGates: (condition: string) => boolean = () => true,
): boolean {
	let cur = idx;
	while (cur !== -1) {
		const b = blocks[cur];
		if (b.unconditionalGate) return true;
		if (b.gateConditions.some(conditionGates)) return true;
		cur = b.parent;
	}
	return false;
}
