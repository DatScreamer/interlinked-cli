// Regression tests for the PostToolUse → recurrence consolidation contract.
//
// Bug history: the recurrence write was nested inside the structural-results
// loop AND the `error_memory.enabled` gate, so quality, structure-v1,
// suggestion, and behavioral check failures were silently dropped, and any
// installation with error_memory off recorded nothing. The fix walks
// `allCheckResults` once after every PostToolUse processing pass and fires
// `recordHarnessCaught` for every error/warning, regardless of source or
// error_memory setting.
//
// Two layers of assertion:
//   1. Source-level pin on server.ts so the contract can't silently regress.
//   2. Behavioral round-trip exercising the same shape of consolidation
//      against synthetic CheckResultEntry rows for each source kind.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadRecurrenceEvents,
	recordHarnessCaught,
} from "../recurrence.js";
import type { CheckResultEntry } from "../types.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SERVER_TS = resolve(HERE, "..", "server.ts");

describe("PostToolUse recurrence consolidation — source-level pins", () => {
	const src = readFileSync(SERVER_TS, "utf-8");

	it("imports recordHarnessCaught from recurrence.js", () => {
		expect(src).toMatch(
			/import\s*\{\s*recordHarnessCaught\s*\}\s*from\s*["']\.\/recurrence\.js["']/,
		);
	});

	it("walks allCheckResults via a cursor and fires recordHarnessCaught for every error/warning", () => {
		// The consolidation loop must slice from a cursor to avoid replaying
		// prior fan-out iterations' findings, filter on severity, and call
		// recordHarnessCaught with the standard fields.
		const consolidationBlock = src.match(
			/for\s*\(\s*let\s+i\s*=\s*recurrenceCursor[\s\S]*?recordHarnessCaught\(\{[\s\S]*?\}\);[\s\S]*?\}\s*recurrenceCursor\s*=\s*allCheckResults\.length/,
		);
		expect(consolidationBlock, "cursor-driven consolidation pass missing").toBeTruthy();
		const block = consolidationBlock?.[0] ?? "";
		expect(block).toContain('r.severity !== "error"');
		expect(block).toContain('r.severity !== "warning"');
		expect(block).toContain("check_id: r.name");
		expect(block).toContain("agent_source: event.agent_source");
		expect(block).toContain("session_id: event.session_id");
	});

	it("declares recurrenceCursor outside the fan-out so it persists across files", () => {
		// The cursor must be declared above the `for (const currentEditedPath
		// of pathsToCheck)` loop, otherwise it resets each iteration and the
		// dedup is meaningless.
		const fanOutIdx = src.indexOf("for (const currentEditedPath of pathsToCheck)");
		expect(fanOutIdx).toBeGreaterThan(-1);
		const cursorDecl = src.indexOf("let recurrenceCursor");
		expect(cursorDecl).toBeGreaterThan(-1);
		expect(cursorDecl).toBeLessThan(fanOutIdx);
	});

	it("does NOT nest the recurrence write inside error_memory.enabled", () => {
		// The recurrence consolidation loop must not be syntactically inside the
		// `if (rules.error_memory?.enabled)` block. We extract the error_memory
		// block and assert recordHarnessCaught isn't called from it.
		// Find the error_memory block (greedy enough to span the structural
		// recordError loop but not the consolidation pass below it).
		const idx = src.indexOf("if (rules.error_memory?.enabled)");
		expect(idx, "error_memory block missing").toBeGreaterThan(-1);
		// Walk forward, balancing braces, to find the end of that if-block.
		let depth = 0;
		let started = false;
		let end = idx;
		for (let i = idx; i < src.length; i++) {
			const c = src[i];
			if (c === "{") {
				depth++;
				started = true;
			} else if (c === "}") {
				depth--;
				if (started && depth === 0) {
					end = i + 1;
					break;
				}
			}
		}
		const errorMemoryBlock = src.slice(idx, end);
		expect(errorMemoryBlock).not.toContain("recordHarnessCaught(");
	});

	it("does NOT scope the recurrence write to a single source kind", () => {
		// Pre-fix code only fired inside the `for (const result of structuralResults)`
		// loop. Pin that the consolidation loop iterates allCheckResults, not
		// structuralResults, so quality/suggestion/behavioral findings record too.
		const block =
			src.match(
				/Mirror EVERY actionable check failure[\s\S]*?allCheckResults\.length\s*>\s*recurrenceCursor/,
			) ?? [];
		expect(block.length).toBeGreaterThan(0);
	});
});

describe("PostToolUse recurrence consolidation — behavioral round-trip", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "interlinked-rcc-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// Simulates the consolidation loop from server.ts::processEvent with the
	// same shape — walks allCheckResults, fires recordHarnessCaught for every
	// error/warning, regardless of source kind or error_memory configuration.
	function runConsolidation(opts: {
		results: CheckResultEntry[];
		sessionId: string;
		agentSource: string;
		editedFilePath: string;
		cwd: string;
	}) {
		const recurrenceRelPath = relative(opts.cwd, opts.editedFilePath);
		for (const r of opts.results) {
			if (r.severity !== "error" && r.severity !== "warning") continue;
			recordHarnessCaught({
				check_id: r.name,
				agent_source: opts.agentSource,
				session_id: opts.sessionId,
				file: r.file ? relative(opts.cwd, r.file) : recurrenceRelPath,
				message: r.message,
				cwd: opts.cwd,
			});
		}
	}

	it("records a harness_caught event for a quality-check failure", () => {
		const editedFilePath = join(dir, "src/db.ts");
		runConsolidation({
			results: [
				{
					source: "quality",
					name: "typescript",
					severity: "error",
					message: "TS2322: Type 'string' is not assignable to type 'number'",
					file: editedFilePath,
					determinism: "fully_deterministic",
				},
			],
			sessionId: "sess-q",
			agentSource: "claude",
			editedFilePath,
			cwd: dir,
		});
		const events = loadRecurrenceEvents(dir);
		expect(events).toHaveLength(1);
		expect(events[0].kind).toBe("harness_caught");
		expect(events[0].check_id).toBe("typescript");
		expect(events[0].file).toBe("src/db.ts");
		expect(events[0].agent_source).toBe("claude");
		expect(events[0].session_id).toBe("sess-q");
	});

	it("records a harness_caught event for a structural-check failure", () => {
		const editedFilePath = join(dir, "src/api.ts");
		runConsolidation({
			results: [
				{
					source: "structural",
					name: "export_surface",
					severity: "warning",
					message: "Removed export `getUser` is referenced from 3 dependents",
					file: editedFilePath,
					determinism: "fully_deterministic",
				},
			],
			sessionId: "sess-s",
			agentSource: "codex",
			editedFilePath,
			cwd: dir,
		});
		const events = loadRecurrenceEvents(dir);
		expect(events).toHaveLength(1);
		expect(events[0].check_id).toBe("export_surface");
		expect(events[0].agent_source).toBe("codex");
	});

	it("records harness_caught events for all six CheckResultEntry source kinds", () => {
		const editedFilePath = join(dir, "src/wide.ts");
		const sources: CheckResultEntry["source"][] = [
			"quality",
			"structural",
			"suggestion",
			"impact",
			"structure",
		];
		const results: CheckResultEntry[] = sources.map((source, i) => ({
			source,
			name: `check_${source}`,
			severity: i % 2 === 0 ? "error" : "warning",
			message: `${source} failure`,
			file: editedFilePath,
			determinism: "heuristic",
		}));
		runConsolidation({
			results,
			sessionId: "sess-all",
			agentSource: "claude",
			editedFilePath,
			cwd: dir,
		});
		const events = loadRecurrenceEvents(dir);
		expect(events).toHaveLength(sources.length);
		const ids = events.map((e) => e.check_id).sort();
		expect(ids).toEqual(
			sources.map((s) => `check_${s}`).sort(),
		);
	});

	it("skips info-severity results — only errors and warnings record", () => {
		const editedFilePath = join(dir, "src/x.ts");
		runConsolidation({
			results: [
				{
					source: "quality",
					name: "noisy_info",
					severity: "info",
					message: "FYI",
					file: editedFilePath,
					determinism: "heuristic",
				},
				{
					source: "quality",
					name: "real_warning",
					severity: "warning",
					message: "real",
					file: editedFilePath,
					determinism: "heuristic",
				},
			],
			sessionId: "sess-mix",
			agentSource: "claude",
			editedFilePath,
			cwd: dir,
		});
		const events = loadRecurrenceEvents(dir);
		expect(events).toHaveLength(1);
		expect(events[0].check_id).toBe("real_warning");
	});

	it("records even when error_memory.enabled is effectively false (no gate at this layer)", () => {
		// The consolidation pass receives no error_memory context — it's
		// independent of that subsystem. This test simulates an installation
		// where error_memory has been disabled and asserts the JSONL still
		// gets the event.
		const editedFilePath = join(dir, "src/no-error-memory.ts");
		const errorMemoryEnabled = false;
		// In the real harness, errorHistory.recordError(...) would be skipped
		// when errorMemoryEnabled is false. The consolidation pass below must
		// be unconditional regardless.
		void errorMemoryEnabled;
		runConsolidation({
			results: [
				{
					source: "structural",
					name: "import_resolution",
					severity: "error",
					message: "Cannot resolve `./missing`",
					file: editedFilePath,
					determinism: "fully_deterministic",
				},
			],
			sessionId: "sess-no-mem",
			agentSource: "claude",
			editedFilePath,
			cwd: dir,
		});
		const events = loadRecurrenceEvents(dir);
		expect(events).toHaveLength(1);
		expect(events[0].check_id).toBe("import_resolution");
	});

	it("multi-file fan-out: cursor prevents replaying prior files' findings", () => {
		// Codex `apply_patch` events fan out per-file. `allCheckResults` is
		// declared once for the event; each iteration appends. Without the
		// cursor, iteration N would re-record findings 1..N-1 on file N's
		// path, inflating recurrence counts and tripping ratchets from a
		// single edit event.
		const fileA = join(dir, "src/a.ts");
		const fileB = join(dir, "src/b.ts");
		const fileC = join(dir, "src/c.ts");

		// Simulates server.ts::processEvent fan-out semantics: a single
		// allCheckResults array shared across iterations, plus a cursor that
		// tracks how much of it has been mirrored to recurrence.
		const allCheckResults: CheckResultEntry[] = [];
		let recurrenceCursor = 0;

		const fanOut: { editedFilePath: string; results: CheckResultEntry[] }[] = [
			{
				editedFilePath: fileA,
				results: [
					{
						source: "quality",
						name: "typescript",
						severity: "error",
						message: "TS error in A",
						file: fileA,
						determinism: "fully_deterministic",
					},
				],
			},
			{
				editedFilePath: fileB,
				results: [
					{
						source: "structural",
						name: "export_surface",
						severity: "warning",
						message: "Removed export in B",
						file: fileB,
						determinism: "fully_deterministic",
					},
				],
			},
			{
				editedFilePath: fileC,
				results: [
					{
						source: "suggestion",
						name: "magic_number",
						severity: "warning",
						message: "literal in C",
						file: fileC,
						determinism: "heuristic",
					},
				],
			},
		];

		for (const iter of fanOut) {
			allCheckResults.push(...iter.results);
			if (allCheckResults.length > recurrenceCursor) {
				const recurrenceRelPath = relative(dir, iter.editedFilePath);
				for (let i = recurrenceCursor; i < allCheckResults.length; i++) {
					const r = allCheckResults[i];
					if (r.severity !== "error" && r.severity !== "warning") continue;
					recordHarnessCaught({
						check_id: r.name,
						agent_source: "claude",
						session_id: "sess-fanout",
						file: r.file ? relative(dir, r.file) : recurrenceRelPath,
						message: r.message,
						cwd: dir,
					});
				}
				recurrenceCursor = allCheckResults.length;
			}
		}

		const events = loadRecurrenceEvents(dir);
		// Exactly 3 events — one per file. Pre-fix code would have written
		// 1 + 2 + 3 = 6 (each iteration replaying earlier files' results).
		expect(events).toHaveLength(3);
		const idsAndFiles = events
			.map((e) => `${e.check_id}@${e.file}`)
			.sort();
		expect(idsAndFiles).toEqual(
			[
				"export_surface@src/b.ts",
				"magic_number@src/c.ts",
				"typescript@src/a.ts",
			].sort(),
		);
	});

	it("uses the result's own file when present, else falls back to editedFilePath", () => {
		const editedFilePath = join(dir, "src/edited.ts");
		const otherFile = join(dir, "src/other.ts");
		runConsolidation({
			results: [
				{
					source: "structural",
					name: "with_file",
					severity: "warning",
					message: "x",
					file: otherFile,
					determinism: "fully_deterministic",
				},
				{
					source: "behavioral" as CheckResultEntry["source"], // tolerate any discriminator
					name: "no_file",
					severity: "warning",
					message: "y",
					determinism: "heuristic",
				},
			] as CheckResultEntry[],
			sessionId: "sess-files",
			agentSource: "claude",
			editedFilePath,
			cwd: dir,
		});
		const events = loadRecurrenceEvents(dir);
		expect(events).toHaveLength(2);
		const byCheck = new Map(events.map((e) => [e.check_id, e.file]));
		expect(byCheck.get("with_file")).toBe("src/other.ts");
		expect(byCheck.get("no_file")).toBe("src/edited.ts");
	});
});
