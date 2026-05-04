// ===========================================
// Recurrence Scanner — codebase_existing pattern detector
// ===========================================
//
// Walks the working tree, runs the same inline detectors the harness
// uses on PostToolUse against every source file, and surfaces patterns
// that already exist in the codebase. Useful for the third "kind" of
// recurrence: codebase_existing — pre-existing replications of patterns
// the harness now catches at edit time but hasn't been used to clean
// up the inherited code.
//
// Per `feedback_harness_deterministic_only.md`: counting + grouping +
// regex / AST detectors only. No LLM.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { buildAgentSafetyChecks } from "./check-registry/index.js";
import { recordRecurrenceEvent } from "./recurrence.js";

/** Default directory roots scanned when the caller doesn't override. The
 *  intent is "user-authored source" — node_modules / dist / build / vendor
 *  are skipped via SKIP_DIR_NAMES below regardless of which root we walk. */
const DEFAULT_SCAN_ROOTS = ["src"];

/** File extensions inspected by default. The inline detectors target
 *  TS/JS family and Python/Go/Rust/etc. via the language profile path,
 *  but the agent_safety pipeline is dominated by JS/TS. Add others as
 *  the registry grows. */
const DEFAULT_SCAN_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** Subtree names skipped during the walk — agent-untouchable code paths. */
const SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
	"node_modules",
	"dist",
	"build",
	"vendor",
	".next",
	".git",
	".interlinked",
	"coverage",
]);

/** A single detector hit found by the codebase scan. */
export interface ScanCodebaseFinding {
	/** Path relative to `cwd`. */
	file: string;
	/** Registry check id (e.g., "eval_usage", "misused_promises"). */
	check_id: string;
	/** 1-based line number of the matched line. */
	line: number;
	/** Trimmed source-line text (capped). */
	text: string;
}

export interface ScanCodebaseOptions {
	/** Working directory the scan is rooted at. Defaults to process.cwd(). */
	cwd?: string;
	/** Subdirectories of `cwd` to walk. Defaults to ["src"]. */
	roots?: string[];
	/** File extensions to inspect. Defaults to TS/JS family. */
	extensions?: string[];
	/** When true, append a codebase_existing recurrence event per finding
	 *  to `.interlinked/recurrences.jsonl`. Default false (dry run). */
	recordEvents?: boolean;
}

/** Walk the working tree and return every inline-detector hit found in
 *  the working source. Optionally records a `codebase_existing`
 *  recurrence event per hit (for `interlinked recurrence list` to
 *  aggregate). */
export function scanCodebaseForRecurrences(
	options: ScanCodebaseOptions = {},
): ScanCodebaseFinding[] {
	const cwd = resolve(options.cwd ?? process.cwd());
	const roots = options.roots ?? DEFAULT_SCAN_ROOTS;
	const extensions = options.extensions ?? DEFAULT_SCAN_EXTENSIONS;
	const findings: ScanCodebaseFinding[] = [];

	for (const rootRel of roots) {
		const rootAbs = resolve(cwd, rootRel);
		for (const fileAbs of walk(rootAbs)) {
			if (!extensions.some((ext) => fileAbs.endsWith(ext))) continue;
			const relPath = relative(cwd, fileAbs).split(sep).join("/");
			let content: string;
			try {
				content = readFileSync(fileAbs, "utf-8");
			} catch (_err) {
				/* unreadable (permission, race) — skip */
				continue;
			}
			// Inline detectors registered in CHECK_REGISTRY for the agent_safety
			// pipeline. We pass relPath so detectors that gate on the file path
			// (e.g. test-file detection) see the right shape.
			const checks = buildAgentSafetyChecks(content, relPath);
			for (const check of checks) {
				let matches: Array<{ line: number; text: string }>;
				try {
					matches = check.fn();
				} catch (_err) {
					/* a single buggy detector must not break the whole scan */
					continue;
				}
				for (const m of matches) {
					findings.push({
						file: relPath,
						check_id: check.name,
						line: m.line,
						text: m.text,
					});
				}
			}
		}
	}

	if (options.recordEvents) {
		const ts = new Date().toISOString();
		for (const f of findings) {
			recordRecurrenceEvent(
				{
					ts,
					kind: "codebase_existing",
					check_id: f.check_id,
					file: f.file,
					message: f.text,
				},
				cwd,
			);
		}
	}

	return findings;
}

/** Recursive walker that yields absolute file paths. Skips symlink loops
 *  by stat'ing each entry and refusing to recurse into already-skipped
 *  directory names. */
function* walk(dirAbs: string): Iterable<string> {
	let entries: string[];
	try {
		entries = readdirSync(dirAbs);
	} catch (_err) {
		/* root doesn't exist or is unreadable — empty walk */
		return;
	}
	for (const name of entries) {
		if (SKIP_DIR_NAMES.has(name)) continue;
		const abs = join(dirAbs, name);
		let st: ReturnType<typeof statSync>;
		try {
			st = statSync(abs);
		} catch (_err) {
			continue;
		}
		if (st.isDirectory()) yield* walk(abs);
		else if (st.isFile()) yield abs;
	}
}
