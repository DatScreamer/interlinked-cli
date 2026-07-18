// ===========================================
// PreToolUse test-signal erosion wiring (DW test-adoption P0.3 b/c)
// ===========================================
// The trajectory glue over the pure `test-integrity-prewarn.ts` erosion verdict:
// on a test-file Write/Edit, read the on-disk version, reconstruct the proposed
// version, count test signals in each, and warn (never block) when the edit
// removes test blocks or assertions. Strengthened when the test's prod pair was
// also written this session. Always-on, warn-only, cheap (regex counts over two
// strings); a new test file (no on-disk content) is skipped.

import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import { pairStem } from "../coverage-pairing.js";
import { isTestPath } from "../coverage-test-selector.js";
import { resolveProposedContent } from "../overlay-content.js";
import type { SessionTrajectory } from "../types.js";
import { countTestSignals, testSignalErosion } from "./test-integrity-prewarn.js";
import { isFileWrite } from "./tool-classifiers.js";

function strField(input: JsonObject, key: string): string {
	const v = input[key];
	return typeof v === "string" ? v : "";
}

/** True when the session wrote a NON-test file sharing the edited test's pair
 *  stem — i.e. the test's source changed this session. Format-agnostic (compares
 *  by `pairStem` after POSIX-normalizing), so abs/rel entries both match. */
function prodPairChangedThisSession(session: SessionTrajectory, testRel: string): boolean {
	const stem = pairStem(testRel);
	for (const written of session.files_written) {
		const norm = written.replace(/\\/g, "/");
		if (isTestPath(norm)) continue;
		if (pairStem(norm).endsWith(stem) || stem.endsWith(pairStem(norm))) return true;
	}
	return false;
}

/**
 * PreToolUse test-signal-erosion warning (or null). Fires only for a Write/Edit
 * to an EXISTING test file whose proposed content has fewer test blocks or
 * assertions than the on-disk version. Never blocks.
 */
export function checkTestSignalErosion(
	toolName: string,
	toolInput: JsonObject,
	session: SessionTrajectory,
	cwd: string,
): string | null {
	if (!isFileWrite(toolName)) return null;
	const named = strField(toolInput, "file_path") || strField(toolInput, "path");
	if (!named) return null;
	const abs = resolve(cwd, named);
	const rel = relative(cwd, abs).replace(/\\/g, "/");
	if (!isTestPath(rel)) return null;
	if (!existsSync(abs)) return null; // new test file — nothing to erode

	let before: string;
	try {
		before = readFileSync(abs, "utf-8");
	} catch (e) {
		void e;
		return null;
	}
	if (!before) return null;
	const after = resolveProposedContent(abs, toolInput);

	return testSignalErosion(countTestSignals(before, rel), countTestSignals(after, rel), {
		relPath: rel,
		prodPairChangedThisSession: prodPairChangedThisSession(session, rel),
	});
}
