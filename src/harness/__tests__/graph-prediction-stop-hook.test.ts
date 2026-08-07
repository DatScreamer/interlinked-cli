// ===========================================
// Stop-hook prediction harvest
// ===========================================
// On Stop, scan recent assistant messages in the transcript for fenced
// `graph_prediction:` blocks and persist any that target Case E-fresh
// files to .interlinked/graph-predictions.jsonl. The Fire-2 retry of the
// same edit then hits cache and reconciles.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { findPredictionRow } from "../graph-prediction-cache.js";
import { resetWorkspaceActiveCache } from "../graph-prediction-classifier.js";
import {
	harvestPredictionsFromTranscript,
	readRecentAssistantTexts,
} from "../graph-prediction-stop-hook.js";

/** A flow-list with 51 entries — one past MAX_LIST_ENTRIES — trips the
 *  parser's format_violation path (`graph-prediction-parser-scalars.ts`). */
function overLongFlowList(): string {
	const items = Array.from({ length: 51 }, (_, i) => `"f${i}"`);
	return `[${items.join(", ")}]`;
}

let dir: string;

function setMtime(path: string, ms: number): void {
	const seconds = ms / 1000;
	utimesSync(path, seconds, seconds);
}

function assistantMessage(text: string): string {
	return JSON.stringify({
		type: "assistant",
		message: { content: [{ type: "text", text }] },
	});
}

function writeTranscript(transcriptPath: string, lines: string[]): void {
	mkdirSync(join(dir, "transcripts"), { recursive: true });
	writeFileSync(transcriptPath, `${lines.join("\n")}\n`);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "graph-pred-stop-hook-"));
	resetWorkspaceActiveCache();
	// Make the workspace look active
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "src", "anchor.ts"), "export {}");
	writeFileSync(join(dir, "src", "anchor.graph.ts"), "// @generated");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	resetWorkspaceActiveCache();
});

describe("harvestPredictionsFromTranscript — happy path", () => {
	it("persists an E-fresh prediction extracted from the transcript", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "foo.ts"), "export {}");
		writeFileSync(join(dir, "src", "foo.graph.ts"), "// @generated");
		setMtime(join(dir, "src", "foo.ts"), t);
		setMtime(join(dir, "src", "foo.graph.ts"), t + 30_000);

		const transcriptPath = join(dir, "transcripts", "session.jsonl");
		writeTranscript(transcriptPath, [
			assistantMessage(
				[
					"Here's my prediction:",
					"```yaml",
					"graph_prediction:",
					`  file: ${join(dir, "src", "foo.ts")}`,
					'  deps:',
					'    imports: ["node:net"]',
					'    imported_by: []',
					"```",
				].join("\n"),
			),
		]);

		const harvested = harvestPredictionsFromTranscript({
			cwd: dir,
			sessionId: "sess-1",
			transcriptPath,
		});
		expect(harvested.persisted).toHaveLength(1);
		expect(nonNull(harvested.persisted[0]).case).toBe("E-fresh");

		const row = findPredictionRow(dir, {
			session_id: "sess-1",
			file_path: join(dir, "src", "foo.ts"),
			source_mtime: new Date(t).toISOString(),
			shard_mtime: new Date(t + 30_000).toISOString(),
		});
		expect(row).not.toBeNull();
		expect(row?.case).toBe("E-fresh");
	});
});

describe("harvestPredictionsFromTranscript — non-E-fresh skip", () => {
	it("skips predictions for Case D files (target exists, no shard)", () => {
		writeFileSync(join(dir, "src", "no-shard.ts"), "export {}");
		const transcriptPath = join(dir, "transcripts", "session.jsonl");
		writeTranscript(transcriptPath, [
			assistantMessage(
				[
					"```yaml",
					"graph_prediction:",
					`  file: ${join(dir, "src", "no-shard.ts")}`,
					'  deps:',
					'    imports: []',
					'    imported_by: []',
					"```",
				].join("\n"),
			),
		]);

		const harvested = harvestPredictionsFromTranscript({
			cwd: dir,
			sessionId: "sess-2",
			transcriptPath,
		});
		expect(harvested.persisted).toHaveLength(0);
		expect(harvested.skipped).toHaveLength(1);
		expect(nonNull(harvested.skipped[0]).case).toBe("D");
	});

	it("skips predictions for E-stale files (shard older than source)", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "stale.ts"), "export {}");
		writeFileSync(join(dir, "src", "stale.graph.ts"), "// @generated");
		setMtime(join(dir, "src", "stale.ts"), t);
		setMtime(join(dir, "src", "stale.graph.ts"), t - 120_000);

		const transcriptPath = join(dir, "transcripts", "session.jsonl");
		writeTranscript(transcriptPath, [
			assistantMessage(
				[
					"```yaml",
					"graph_prediction:",
					`  file: ${join(dir, "src", "stale.ts")}`,
					'  deps:',
					'    imports: []',
					'    imported_by: []',
					"```",
				].join("\n"),
			),
		]);

		const harvested = harvestPredictionsFromTranscript({
			cwd: dir,
			sessionId: "sess-3",
			transcriptPath,
		});
		expect(harvested.persisted).toHaveLength(0);
		expect(nonNull(harvested.skipped[0]).case).toBe("E-stale");
	});

	it("tags a non-E-fresh skip with reason format_violation when the prediction itself is malformed", () => {
		writeFileSync(join(dir, "src", "no-shard2.ts"), "export {}");
		const transcriptPath = join(dir, "transcripts", "session.jsonl");
		writeTranscript(transcriptPath, [
			assistantMessage(
				[
					"```yaml",
					"graph_prediction:",
					`  file: ${join(dir, "src", "no-shard2.ts")}`,
					"  deps:",
					`    imports: ${overLongFlowList()}`,
					"    imported_by: []",
					"```",
				].join("\n"),
			),
		]);

		const harvested = harvestPredictionsFromTranscript({
			cwd: dir,
			sessionId: "sess-fv-case-d",
			transcriptPath,
		});
		expect(harvested.persisted).toHaveLength(0);
		expect(harvested.skipped).toEqual([
			{
				file_path: join(dir, "src", "no-shard2.ts"),
				case: "D",
				reason: "format_violation",
			},
		]);
	});
});

describe("harvestPredictionsFromTranscript — E-fresh + format_violation", () => {
	it("skips persistence for an E-fresh prediction that itself violates the list-entry cap", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "fv.ts"), "export {}");
		writeFileSync(join(dir, "src", "fv.graph.ts"), "// @generated");
		setMtime(join(dir, "src", "fv.ts"), t);
		setMtime(join(dir, "src", "fv.graph.ts"), t + 30_000);

		const transcriptPath = join(dir, "transcripts", "session.jsonl");
		writeTranscript(transcriptPath, [
			assistantMessage(
				[
					"```yaml",
					"graph_prediction:",
					`  file: ${join(dir, "src", "fv.ts")}`,
					"  deps:",
					`    imports: ${overLongFlowList()}`,
					"    imported_by: []",
					"```",
				].join("\n"),
			),
		]);

		const harvested = harvestPredictionsFromTranscript({
			cwd: dir,
			sessionId: "sess-fv-efresh",
			transcriptPath,
		});
		expect(harvested.persisted).toEqual([]);
		expect(harvested.skipped).toEqual([
			{
				file_path: join(dir, "src", "fv.ts"),
				case: "E-fresh",
				reason: "format_violation",
			},
		]);
	});
});

describe("harvestPredictionsFromTranscript — multi-file", () => {
	it("persists every E-fresh prediction in the response", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		for (const name of ["a", "b"]) {
			writeFileSync(join(dir, "src", `${name}.ts`), "export {}");
			writeFileSync(join(dir, "src", `${name}.graph.ts`), "// @generated");
			setMtime(join(dir, "src", `${name}.ts`), t);
			setMtime(join(dir, "src", `${name}.graph.ts`), t);
		}
		const transcriptPath = join(dir, "transcripts", "session.jsonl");
		writeTranscript(transcriptPath, [
			assistantMessage(
				[
					"```yaml",
					"graph_prediction:",
					`  file: ${join(dir, "src", "a.ts")}`,
					'  deps:',
					'    imports: []',
					'    imported_by: []',
					"```",
					"```yaml",
					"graph_prediction:",
					`  file: ${join(dir, "src", "b.ts")}`,
					'  deps:',
					'    imports: []',
					'    imported_by: []',
					"```",
				].join("\n"),
			),
		]);

		const harvested = harvestPredictionsFromTranscript({
			cwd: dir,
			sessionId: "sess-multi",
			transcriptPath,
		});
		expect(harvested.persisted).toHaveLength(2);
	});
});

describe("harvestPredictionsFromTranscript — degenerate inputs", () => {
	it("returns empty when transcript path is undefined", () => {
		const r = harvestPredictionsFromTranscript({
			cwd: dir,
			sessionId: "x",
			transcriptPath: undefined,
		});
		expect(r.persisted).toEqual([]);
		expect(r.skipped).toEqual([]);
	});

	it("returns empty when transcript file does not exist", () => {
		const r = harvestPredictionsFromTranscript({
			cwd: dir,
			sessionId: "x",
			transcriptPath: join(dir, "no-such-file.jsonl"),
		});
		expect(r.persisted).toEqual([]);
	});

	it("tolerates malformed transcript lines", () => {
		const transcriptPath = join(dir, "transcripts", "session.jsonl");
		writeTranscript(transcriptPath, [
			"garbage line not json",
			'{ broken json',
			assistantMessage("just prose, no fenced block"),
		]);
		const r = harvestPredictionsFromTranscript({
			cwd: dir,
			sessionId: "sess-malformed",
			transcriptPath,
		});
		expect(r.persisted).toEqual([]);
	});

	it("skips predictions whose parse_status is parse_failed", () => {
		writeFileSync(join(dir, "src", "p.ts"), "export {}");
		writeFileSync(join(dir, "src", "p.graph.ts"), "// @generated");
		const transcriptPath = join(dir, "transcripts", "session.jsonl");
		writeTranscript(transcriptPath, [
			assistantMessage(
				[
					"```yaml",
					"graph_prediction:",
					"  this is { not: ] valid yaml",
					"```",
				].join("\n"),
			),
		]);
		const r = harvestPredictionsFromTranscript({
			cwd: dir,
			sessionId: "sess-bad",
			transcriptPath,
		});
		expect(r.persisted).toEqual([]);
	});
});

describe("readRecentAssistantTexts", () => {
	it("returns [] when the path exists but cannot be read as a file (EISDIR)", () => {
		// `dir` is a directory, not a file — readFileSync throws.
		expect(readRecentAssistantTexts(dir)).toEqual([]);
	});

	it("caps at RECENT_ASSISTANT_MESSAGE_LIMIT (10) even with more messages available", () => {
		const transcriptPath = join(dir, "transcripts", "session.jsonl");
		const lines = Array.from({ length: 12 }, (_, i) => assistantMessage(`msg-${i}`));
		writeTranscript(transcriptPath, lines);
		const texts = readRecentAssistantTexts(transcriptPath);
		expect(texts).toHaveLength(10);
		// Walked backwards then reversed: the 10 most recent, oldest-first.
		expect(texts).toEqual(["msg-2", "msg-3", "msg-4", "msg-5", "msg-6", "msg-7", "msg-8", "msg-9", "msg-10", "msg-11"]);
	});

	it("skips non-object and non-assistant JSON lines, and blocks that carry no usable text", () => {
		const transcriptPath = join(dir, "transcripts", "session.jsonl");
		writeTranscript(transcriptPath, [
			"42", // valid JSON, not an object
			"null", // valid JSON, null
			JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "ignored" }] } }),
			JSON.stringify({ type: "assistant", message: { content: "not-an-array" } }),
			JSON.stringify({ type: "assistant", message: { content: [{ type: "other" }] } }),
			JSON.stringify({
				type: "assistant",
				message: {
					content: [
						null,
						"a-bare-string",
						{ type: "other" },
						{ type: "text", text: 123 },
						{ type: "text", text: "kept" },
					],
				},
			}),
		]);
		expect(readRecentAssistantTexts(transcriptPath)).toEqual(["kept"]);
	});
});
