// ============================================================
// Built-in verify-passes (Mythos blog adaptation, Phase 3)
// ============================================================
// Each pass is a second-pass FP filter for a specific check id.
// They run AFTER the detector regex has produced candidates and
// BEFORE results reach the agent. Generalizes manually-landed
// FP fixes (e.g. commit aac4e2a's typeof exemption) into a
// pluggable layer the harness can reuse for future FP classes.

import type { InlineMatch } from "../checks/shared.js";
import { registerVerifyPass } from "./verify-pass.js";

const FIXTURE_PATH_RE = /(?:^|\/)(?:__fixtures__|fixtures|test-data|testdata)\//;

/** Read 1-based line `lineNo` from `content` and return its text
 *  trimmed of leading whitespace. Empty string when out of range. */
function lineAt(content: string, lineNo: number): string {
	if (lineNo < 1) return "";
	const lines = content.split("\n");
	if (lineNo > lines.length) return "";
	return lines[lineNo - 1].trim();
}

/** True when the line at `lineNo` looks like a typeof-narrowing
 *  conditional — e.g. `if (typeof x === "string")`. */
function isTypeofNarrowingLine(content: string, lineNo: number): boolean {
	return /\btypeof\s+[\w.]+\s*(?:===?|!==?)/.test(lineAt(content, lineNo));
}

/** True when the line at `lineNo` is a `case` arm inside a switch.
 *  We don't try to verify the enclosing `switch (...)` — the leading
 *  `case` keyword is enough to skip these false positives. */
function isCaseArmLine(content: string, lineNo: number): boolean {
	return /^case\s+/.test(lineAt(content, lineNo));
}

/** True when the file path lives under a fixture / test-data tree
 *  where magic-literal-in-conditional findings are by design. */
function isFixturePath(filePath: string): boolean {
	return FIXTURE_PATH_RE.test(filePath.replace(/\\/g, "/"));
}

/** True when the match's line text contains an `enum`-style
 *  comparison (a name that's all-caps or a known Status/State
 *  identifier). Heuristic — keeps the rule simple. */
function isEnumComparisonMatch(m: InlineMatch): boolean {
	// Looks for `=== SOMETHING_LIKE_THIS` or `=== Status.X`.
	return /===?\s*(?:[A-Z][A-Z0-9_]+|\w+\.[A-Z]\w+)/.test(m.text);
}

/** Register all built-in verify-passes. Call once at daemon startup
 *  (or once per test, after `resetVerifyPassesForTesting`). */
export function registerAllBuiltinVerifyPasses(): void {
	// magic_literal_in_conditional — generalize commit aac4e2a's
	// typeof exemption. Drop matches that fall into the four known
	// FP shapes: typeof narrowing, case arms, enum comparisons,
	// fixture-tree files.
	registerVerifyPass({
		checkId: "magic_literal_in_conditional",
		rationale: "typeof-narrowing branches are deliberate type guards, not magic literals",
		verify: (m, content) => !isTypeofNarrowingLine(content, m.line),
	});
	registerVerifyPass({
		checkId: "magic_literal_in_conditional",
		rationale: "switch case arms enumerate states by design",
		verify: (m, content) => !isCaseArmLine(content, m.line),
	});
	registerVerifyPass({
		checkId: "magic_literal_in_conditional",
		rationale: "enum / status comparisons are self-documenting",
		verify: (m) => !isEnumComparisonMatch(m),
	});
	registerVerifyPass({
		checkId: "magic_literal_in_conditional",
		rationale: "fixture / test-data files contain literal expectations on purpose",
		verify: (_m, _content, filePath) => !isFixturePath(filePath),
	});
}
