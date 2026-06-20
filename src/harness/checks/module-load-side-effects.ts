// Top-level (import-time) side-effect detector.
//
// The TS coding standard says modules should not perform I/O, open
// connections, start servers, or read env at import time — module load should
// be free of side effects so the module is testable and import order can't
// cause ordering bugs. This flags a side-effecting call that executes at the
// top level (column 0, not inside a function/class body).
//
// Heuristic (column-0 proxy for "top level" + regex over stripped content) →
// findings tagged `[heuristic]`. Ships advisory. Entrypoint modules
// (index/server/cli/hook-entry/bootstrap/setup) are exempt — bootstrapping is
// exactly where import-time setup belongs.

import type { InlineMatch } from "./shared.js";
import { stripCommentsAndStrings } from "./shared.js";

/** Side-effecting calls: fs writes/reads, process spawns, servers, network. */
const SIDE_EFFECT_RE =
	/\b(?:readFileSync|writeFileSync|appendFileSync|existsSync|mkdirSync|rmSync|readdirSync|execSync|spawnSync|createServer)\s*\(|\.listen\s*\(|\bfetch\s*\(/;
/** A line that DEFINES a function/class defers its body — the call won't run
 *  at import. Skip those to avoid flagging deferred I/O. */
const DEFERRED_RE = /=>|\bfunction\b|\bclass\b/;
const JS_TS_RE = /\.[mc]?[jt]sx?$/;
const TEST_RE = /\.(?:test|spec)\.[mc]?[jt]sx?$|\/__tests__\//;
const ENTRYPOINT_NAMES: ReadonlySet<string> = new Set([
	"index",
	"main",
	"server",
	"cli",
	"hook-entry",
	"bootstrap",
	"setup",
]);

function basenameNoExt(filePath: string): string {
	const base = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
	return base.replace(/\.[^.]+$/, "");
}

/**
 * Find side-effecting calls executed at module load (top level).
 *
 * @param content - The source text to scan.
 * @param filePath - The file's path (entrypoints are exempt).
 * @returns One match per top-level side-effecting line.
 */
export function findTopLevelSideEffects(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_RE.test(filePath)) return [];
	if (TEST_RE.test(filePath)) return [];
	if (ENTRYPOINT_NAMES.has(basenameNoExt(filePath))) return [];
	const rawLines = content.split("\n");
	const strippedLines = stripCommentsAndStrings(content).split("\n");
	const out: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		const s = strippedLines[i] ?? "";
		if (s === "" || /^\s/.test(s)) continue; // indented → nested → not top level
		if (DEFERRED_RE.test(s)) continue; // function/class definition → call deferred
		if (!SIDE_EFFECT_RE.test(s)) continue;
		out.push({ line: i + 1, text: (rawLines[i] ?? "").trim().slice(0, 150) });
	}
	return out;
}
