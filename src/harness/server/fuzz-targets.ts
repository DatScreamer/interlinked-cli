// ===========================================
// Fuzz/property target detection (DW P4 §4 job 2 — fuzz-smoke)
// ===========================================
// A fuzz target here is a test file that drives fast-check (property-based
// testing). Detection is CONTENT-based, not filename-based: `property-budget.test.ts`
// and `property-testing.test.ts` have "property" in the name but test the
// budget/lint modules, not fast-check — so we look for an actual fast-check
// import or `fc.assert` / `fc.property` call. The SessionEnd fuzz-smoke job runs
// exactly these, hard (elevated numRuns), to recover the search depth the
// per-edit cap (P0.1) trades away. Bounded walk; best-effort (never throws).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Cap the walk so a huge tree can't stall SessionEnd. */
const MAX_FILES_SCANNED = 4000;
const FASTCHECK_RE = /from\s+["']fast-check["']|\bfc\.(?:assert|property|asyncProperty)\s*\(/;

function walk(dir: string, out: string[], budget: { n: number }): void {
	if (budget.n >= MAX_FILES_SCANNED) return;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch (err) {
		void err; // unreadable dir — skip this branch
		return;
	}
	for (const name of entries) {
		if (budget.n >= MAX_FILES_SCANNED) return;
		if (name === "node_modules" || name === ".git" || name === "dist") continue;
		const full = join(dir, name);
		let isDir = false;
		try {
			isDir = statSync(full).isDirectory();
		} catch (err) {
			void err; // vanished / unstattable — skip
			continue;
		}
		if (isDir) {
			walk(full, out, budget);
		} else if (name.endsWith(".test.ts") || name.endsWith(".test.tsx")) {
			budget.n++;
			out.push(full);
		}
	}
}

/**
 * Repo-relative POSIX paths of the test files that drive fast-check, or []. Reads
 * each candidate test file (bounded) and keeps those with a fast-check import or
 * assertion. Never throws.
 */
export function detectFuzzTargets(cwd: string): string[] {
	const candidates: string[] = [];
	walk(join(cwd, "src"), candidates, { n: 0 });
	const targets: string[] = [];
	for (const abs of candidates) {
		try {
			if (FASTCHECK_RE.test(readFileSync(abs, "utf-8"))) {
				targets.push(relative(cwd, abs).replace(/\\/g, "/"));
			}
		} catch (err) {
			void err; // unreadable file — skip
		}
	}
	return targets;
}
