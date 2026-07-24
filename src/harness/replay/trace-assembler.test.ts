// T1 trace assembler — joins the three capture surfaces into the
// `replay-trace.v1` spine (docs/design/reproducibility/README.md §Trace
// spine): collection tool events (action + result, keyed by seq/tool_use_id)
// ⋈ inference envelopes (exact observation, joined by tool_use_id, then
// stamped with session/seq) ⋈ tree/state snapshots (pre/post trees + state
// ref per seq). Envelope-less steps still produce trace rows (observation_ref
// null) — a session captured without the proxy is degraded, not empty.

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendEnvelope, type InferenceEnvelope } from "./inference-store.js";
import { assembleTrace, loadTrace } from "./trace-assembler.js";

const cleanups: string[] = [];
afterEach(() => {
	for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SESSION = "sess-t1";

function fixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "il-t1-"));
	cleanups.push(dir);
	mkdirSync(join(dir, ".interlinked", "replay", "snapshots"), { recursive: true });
	return dir;
}

function collectionRow(row: Record<string, unknown>): string {
	return `${JSON.stringify({ schema: "collection.v1", kind: "tool_event", session_id: SESSION, ...row })}\n`;
}

function writeCollection(dir: string, rows: string[]): void {
	appendFileSync(join(dir, ".interlinked", "collection.jsonl"), rows.join(""));
}

function writeSnapshotRow(dir: string, row: Record<string, unknown>): void {
	appendFileSync(
		join(dir, ".interlinked", "replay", "snapshots", "index.jsonl"),
		`${JSON.stringify({ schema: "tree-snapshot.v1", session_id: SESSION, backend: "git", commit: "c", ts: "t", ...row })}\n`,
	);
}

function envelope(toolUseId: string): InferenceEnvelope {
	return {
		schema: "inference-envelope.v1",
		request_index: 1,
		ts_request: "2026-07-24T12:00:00.000Z",
		ts_response: "2026-07-24T12:00:01.000Z",
		latency_ms: 1000,
		provider: "anthropic",
		request_headers: {},
		request: { model: "m", messages: [] },
		response: { id: "msg", content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: {} }] },
		tool_use_ids: [toolUseId],
		request_sha256: "0".repeat(64),
		session_id: null,
		seq: null,
	};
}

function seedStandardFixture(dir: string): void {
	writeCollection(dir, [
		collectionRow({
			ts: "2026-07-24T12:00:01.100Z",
			seq: 1,
			tool_use_id: "toolu_a",
			phase: "pre",
			provider_tool: "Bash",
			action: { command: "ls", cwd: null },
		}),
		collectionRow({
			ts: "2026-07-24T12:00:01.900Z",
			seq: 2,
			tool_use_id: "toolu_a",
			phase: "post",
			outcome: "ok",
			provider_tool: "Bash",
			observation: { stdout: "files" },
		}),
		collectionRow({
			ts: "2026-07-24T12:00:05.000Z",
			seq: 3,
			tool_use_id: "toolu_b",
			phase: "pre",
			provider_tool: "Read",
			action: { path: "/x.ts" },
		}),
	]);
	writeSnapshotRow(dir, { seq: 1, tool_use_id: "toolu_a", phase: "pre", tree: "tree-pre-a" });
	writeSnapshotRow(dir, { seq: 2, tool_use_id: "toolu_a", phase: "post", tree: "tree-post-a" });
	appendEnvelope(join(dir, ".interlinked", "replay"), envelope("toolu_a"));
}

describe("assembleTrace", () => {
	it("builds one step per pre event, joined across all three surfaces", () => {
		const dir = fixture();
		seedStandardFixture(dir);
		const summary = assembleTrace(dir, SESSION);
		expect(summary.steps).toBe(2);
		expect(summary.steps_with_envelope).toBe(1);

		const steps = loadTrace(dir, SESSION);
		expect(steps).toHaveLength(2);
		const first = steps[0];
		expect(first?.key).toEqual({
			session_id: SESSION,
			seq: 1,
			tool_use_id: "toolu_a",
			ts: "2026-07-24T12:00:01.100Z",
		});
		expect(first?.action).toEqual({ tool: "Bash", input: { command: "ls", cwd: null } });
		expect(first?.result).toEqual({ outcome: "ok", observation: { stdout: "files" } });
		expect(first?.pre_tree).toBe("tree-pre-a");
		expect(first?.post_tree).toBe("tree-post-a");
		expect(first?.observation_ref).toContain("inference/");
	});

	it("leaves observation_ref null for envelope-less steps (degraded, not dropped)", () => {
		const dir = fixture();
		seedStandardFixture(dir);
		assembleTrace(dir, SESSION);
		const second = loadTrace(dir, SESSION)[1];
		expect(second?.key.tool_use_id).toBe("toolu_b");
		expect(second?.observation_ref).toBeNull();
		expect(second?.result).toBeNull();
		expect(second?.pre_tree).toBeNull();
	});

	it("stamps joined envelopes with session/seq into the per-session file", () => {
		const dir = fixture();
		seedStandardFixture(dir);
		assembleTrace(dir, SESSION);
		const perSession = readFileSync(
			join(dir, ".interlinked", "replay", "inference", `${SESSION}.jsonl`),
			"utf-8",
		)
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as InferenceEnvelope);
		expect(perSession).toHaveLength(1);
		expect(perSession[0]?.session_id).toBe(SESSION);
		expect(perSession[0]?.seq).toBe(1);
	});

	it("ignores other sessions' rows and returns zeros for an unknown session", () => {
		const dir = fixture();
		seedStandardFixture(dir);
		const summary = assembleTrace(dir, "someone-else");
		expect(summary.steps).toBe(0);
		expect(loadTrace(dir, "someone-else")).toEqual([]);
	});

	it("is idempotent — reassembling overwrites rather than duplicating", () => {
		const dir = fixture();
		seedStandardFixture(dir);
		assembleTrace(dir, SESSION);
		assembleTrace(dir, SESSION);
		expect(loadTrace(dir, SESSION)).toHaveLength(2);
	});
});
