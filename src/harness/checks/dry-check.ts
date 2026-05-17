// I/O wrapper for the pure DRY clone detector (`dry.ts`).
//
// `dry.ts` is intentionally pure -- it never touches the filesystem. This
// module is the thin shell that the check registry calls: it reads the
// edited file's sibling files (same directory only -- the bounded candidate
// set the latency contract requires) and adapts `CloneFinding[]` to the
// `InlineMatch[]` shape every registered check returns.
//
// Sibling scan is deliberately shallow: same directory, JS/TS only, skipping
// the edited file itself, test files, and anything oversized. No recursion,
// no whole-repo walk -- O(files-in-one-directory), which is what keeps this
// inside the PostToolUse budget.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CloneFinding, FunctionShingles } from "./dry.js";
import { extractFunctionShingles, findClones } from "./dry.js";
import { getExtension, type InlineMatch, isTestFile, JS_TS_EXTS } from "./shared.js";

/** Largest sibling file (bytes) we will read + tokenize. Skips bundles. */
const MAX_SIBLING_BYTES = 256 * 1024;

/** Cap on sibling files scanned, so a huge flat directory can't blow the budget. */
const MAX_SIBLINGS = 40;

/**
 * Registered-check entry point for the DRY clone detector.
 * Public API -- consumed by `check-registry/entries-warnings.ts` and
 * `verify/file-checks.ts`.
 *
 * Returns one {@link InlineMatch} per edited-file function that has a
 * near-duplicate (>= the default Jaccard threshold) either elsewhere in the
 * same file or in a sibling file. Returns `[]` for unsupported extensions and
 * test files. Sibling-read failures are swallowed -- a clone check must never
 * break an edit.
 */
export function checkCodeClones(content: string, filePath: string): InlineMatch[] {
	return checkCodeCloneFindings(content, filePath).map(formatCodeCloneFinding(filePath));
}

/**
 * Return raw clone findings for callers that need to apply a pre-edit
 * baseline before rendering the registered InlineMatch shape.
 */
export function checkCodeCloneFindings(content: string, filePath: string): CloneFinding[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	const edited = extractFunctionShingles(content, filePath);
	if (edited.length === 0) return [];

	const candidates = collectSiblingFunctions(filePath);
	return findClones({ edited, candidates });
}

/** Adapt a raw clone pair to the generic registry InlineMatch shape. */
export function formatCodeCloneFinding(filePath: string): (finding: CloneFinding) => InlineMatch {
	return (f) => {
		const where =
			f.otherFile === filePath
				? `same file (line ${f.otherLine})`
				: `${f.otherFile}:${f.otherLine}`;
		return {
			line: f.line,
			text: `${f.name}() is ${Math.round(f.similarity * 100)}% similar to ${f.otherName}() in ${where} -- extract the shared logic`,
		};
	};
}

/**
 * Read JS/TS sibling files in the edited file's directory and extract their
 * functions. Bounded, non-recursive. Any filesystem error is swallowed: the
 * candidate set just shrinks, the check still runs on within-file clones.
 */
export function collectSiblingFunctions(filePath: string): FunctionShingles[] {
	const dir = dirname(filePath);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		// Directory unreadable — fall back to within-file clone detection only.
		return [];
	}

	const out: FunctionShingles[] = [];
	let scanned = 0;
	for (const entry of entries) {
		if (scanned >= MAX_SIBLINGS) break;
		const sibPath = join(dir, entry);
		if (sibPath === filePath) continue;
		if (!JS_TS_EXTS.has(getExtension(sibPath))) continue;
		if (isTestFile(sibPath)) continue;

		const sibContent = readSiblingIfSmall(sibPath);
		if (sibContent === null) continue;
		scanned++;
		out.push(...extractFunctionShingles(sibContent, sibPath));
	}
	return out;
}

/**
 * Read a sibling file, or return `null` when it is missing, unreadable, or
 * larger than {@link MAX_SIBLING_BYTES}. Isolating the try/catch here keeps
 * the scan loop free of a swallowed-error block.
 */
function readSiblingIfSmall(sibPath: string): string | null {
	try {
		if (statSync(sibPath).size > MAX_SIBLING_BYTES) return null;
		return readFileSync(sibPath, "utf-8");
	} catch {
		// Unreadable sibling — skip it; the candidate set just shrinks.
		return null;
	}
}
