// Mutation-kill suite (wave 36) for trace-assembler.ts survivors.
// Targets: readCollectionRows schema/kind filtering, bySeqThenTs missing-ts
// fallback, snapshotTree's tool-use-id guard, buildStep's outcome typeof
// check, assembleTrace's state_ref path + trailing-newline serialization,
// and the parseTraceStepKey/parseTraceAction/parseTraceResult/parseTraceStep
// validation guards (each rejects malformed shapes rather than silently
// coercing them).

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleTrace, loadTrace, parseTraceStep } from "./trace-assembler.js";

const cleanups: string[] = [];
afterEach(() => {
	for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SESSION = "w36-session";

function fixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "il-t1-w36-"));
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

describe("readCollectionRows schema/kind filtering", () => {
	// test-contract: invariant — a row whose schema is not "collection.v1" must never become a step, even with matching kind/session_id.
	it("excludes a row whose schema does not match collection.v1", () => {
		const dir = fixture();
		writeCollection(dir, [
			collectionRow({
				schema: "some-other.v1",
				phase: "pre",
				seq: 1,
				tool_use_id: "toolu_wrong_schema",
				ts: "t1",
				provider_tool: "Bash",
				action: { command: "x" },
			}),
		]);
		const summary = assembleTrace(dir, SESSION);
		expect(summary.steps).toBe(0);
	});

	// test-contract: invariant — a row whose kind is not "tool_event" must never become a step, even with matching schema/session_id.
	it("excludes a row whose kind does not match tool_event", () => {
		const dir = fixture();
		writeCollection(dir, [
			collectionRow({
				kind: "something-else",
				phase: "pre",
				seq: 1,
				tool_use_id: "toolu_wrong_kind",
				ts: "t1",
				provider_tool: "Bash",
				action: { command: "x" },
			}),
		]);
		const summary = assembleTrace(dir, SESSION);
		expect(summary.steps).toBe(0);
	});
});

describe("bySeqThenTs missing-ts fallback", () => {
	// test-contract: invariant — a missing ts must sort as the empty string, never as the literal text "undefined".
	it("sorts a pre-row with no ts field before one with a later alphabetic ts (equal seq)", () => {
		const dir = fixture();
		writeCollection(dir, [
			`${JSON.stringify({
				schema: "collection.v1",
				kind: "tool_event",
				session_id: SESSION,
				phase: "pre",
				seq: 5,
				tool_use_id: "toolu_has_ts",
				ts: "b-row",
				provider_tool: "Bash",
				action: { command: "b" },
			})}\n`,
			`${JSON.stringify({
				schema: "collection.v1",
				kind: "tool_event",
				session_id: SESSION,
				phase: "pre",
				seq: 5,
				tool_use_id: "toolu_no_ts",
				provider_tool: "Bash",
				action: { command: "a" },
			})}\n`,
		]);
		assembleTrace(dir, SESSION);
		const steps = loadTrace(dir, SESSION);
		expect(steps.map((s) => s.key.tool_use_id)).toEqual(["toolu_no_ts", "toolu_has_ts"]);
	});
});

describe("snapshotTree tool_use_id guard", () => {
	// test-contract: invariant — a step with no tool_use_id must never match a snapshot row, even one literally keyed tool_use_id: null.
	it("returns null pre_tree for a tool-use-id-less step even when a null-keyed snapshot exists", () => {
		const dir = fixture();
		writeCollection(dir, [
			collectionRow({
				phase: "pre",
				seq: 1,
				ts: "t1",
				provider_tool: "Bash",
				action: { command: "x" },
			}),
		]);
		appendFileSync(
			join(dir, ".interlinked", "replay", "snapshots", "index.jsonl"),
			`${JSON.stringify({
				schema: "tree-snapshot.v1",
				session_id: SESSION,
				backend: "git",
				commit: "c",
				ts: "t",
				tool_use_id: null,
				phase: "pre",
				tree: "should-never-match",
			})}\n`,
		);
		assembleTrace(dir, SESSION);
		const step = loadTrace(dir, SESSION)[0];
		expect(step?.pre_tree).toBeNull();
	});
});

describe("buildStep outcome typeof check", () => {
	// test-contract: invariant — a post row's real string outcome must pass through unchanged, not be collapsed to the "ok" default.
	it("preserves a non-'ok' string outcome from the post row", () => {
		const dir = fixture();
		writeCollection(dir, [
			collectionRow({
				phase: "pre",
				seq: 1,
				tool_use_id: "toolu_custom",
				ts: "t1",
				provider_tool: "Bash",
				action: { command: "run" },
			}),
			collectionRow({
				phase: "post",
				seq: 2,
				tool_use_id: "toolu_custom",
				ts: "t2",
				outcome: "custom_outcome",
				observation: { x: 1 },
			}),
		]);
		assembleTrace(dir, SESSION);
		const step = loadTrace(dir, SESSION)[0];
		expect(step?.result).toEqual({ outcome: "custom_outcome", observation: { x: 1 } });
	});
});

describe("assembleTrace state_ref and file serialization", () => {
	// test-contract: invariant — state_ref is null unless the SPECIFIC per-session state file exists, not merely the state directory.
	it("leaves state_ref null when the state directory exists but the session's file does not", () => {
		const dir = fixture();
		writeCollection(dir, [
			collectionRow({
				phase: "pre",
				seq: 1,
				tool_use_id: "toolu_state",
				ts: "t1",
				provider_tool: "Bash",
				action: { command: "ls" },
			}),
		]);
		mkdirSync(join(dir, ".interlinked", "replay", "state"), { recursive: true });
		assembleTrace(dir, SESSION);
		const step = loadTrace(dir, SESSION)[0];
		expect(step?.state_ref).toBeNull();
	});

	// test-contract: invariant — an empty trace (zero steps) must write an empty file, not filler text.
	it("writes an empty trace file when there are zero steps", () => {
		const dir = fixture();
		const summary = assembleTrace(dir, SESSION);
		expect(summary.steps).toBe(0);
		const content = readFileSync(
			join(dir, ".interlinked", "replay", "trace", `${SESSION}.jsonl`),
			"utf-8",
		);
		expect(content).toBe("");
	});

	// test-contract: invariant — a non-empty trace file must end with a trailing newline after the last JSON line.
	it("ends a non-empty trace file with a trailing newline", () => {
		const dir = fixture();
		writeCollection(dir, [
			collectionRow({
				phase: "pre",
				seq: 1,
				tool_use_id: "toolu_nl",
				ts: "t1",
				provider_tool: "Bash",
				action: { command: "ls" },
			}),
		]);
		assembleTrace(dir, SESSION);
		const content = readFileSync(
			join(dir, ".interlinked", "replay", "trace", `${SESSION}.jsonl`),
			"utf-8",
		);
		expect(content.endsWith("\n")).toBe(true);
		expect(content).toBe(`${content.trimEnd()}\n`);
	});
});

describe("parseTraceStep field-level validation guards", () => {
	const full = {
		schema: "replay-trace.v1",
		key: { session_id: SESSION, seq: 1, tool_use_id: "toolu_a", ts: "2026-08-10T00:00:00Z" },
		observation_ref: "inference/sess.jsonl#seq=1",
		action: { tool: "Bash", input: { command: "ls" } },
		result: { outcome: "ok", observation: { stdout: "x" } },
		pre_tree: "tree-pre",
		post_tree: "tree-post",
		state_ref: "state/sess.jsonl#seq=1",
	};

	// test-contract: invariant — parseTraceStepKey must reject a non-plain-object key even when it exposes matching session_id/ts via custom array properties.
	it("rejects a key that is an array carrying session_id/ts as custom properties", () => {
		const arrayKey = Object.assign(["not-a-plain-object"], {
			session_id: SESSION,
			ts: "t",
		});
		expect(parseTraceStep({ ...full, key: arrayKey })).toBeNull();
	});

	// test-contract: invariant — a key.ts that is not a string must reject the whole step.
	it("rejects a key whose ts is a number", () => {
		expect(
			parseTraceStep({ ...full, key: { session_id: SESSION, seq: 1, tool_use_id: "t", ts: 123 } }),
		).toBeNull();
	});

	// test-contract: invariant — a key.seq that is neither null nor a number must reject the whole step.
	it("rejects a key whose seq is a numeric string", () => {
		expect(
			parseTraceStep({
				...full,
				key: { session_id: SESSION, seq: "5", tool_use_id: "t", ts: "t" },
			}),
		).toBeNull();
	});

	// test-contract: invariant — a key.tool_use_id that is neither null nor a string must reject the whole step.
	it("rejects a key whose tool_use_id is a number", () => {
		expect(
			parseTraceStep({
				...full,
				key: { session_id: SESSION, seq: 1, tool_use_id: 123, ts: "t" },
			}),
		).toBeNull();
	});

	// test-contract: invariant — action.tool that is neither null nor a string must reject the whole step.
	it("rejects an action whose tool is a number", () => {
		expect(parseTraceStep({ ...full, action: { tool: 123, input: null } })).toBeNull();
	});

	// test-contract: invariant — action.input that is neither null nor a JSON object must reject the whole step.
	it("rejects an action whose input is a string", () => {
		expect(parseTraceStep({ ...full, action: { tool: "Bash", input: "not-an-object" } })).toBeNull();
	});

	// test-contract: invariant — parseTraceResult must reject a non-plain-object result even when it exposes matching outcome/observation via custom array properties.
	it("rejects a result that is an array carrying outcome/observation as custom properties", () => {
		const arrayResult = Object.assign(["not-a-plain-object"], {
			outcome: "custom",
			observation: null,
		});
		expect(parseTraceStep({ ...full, result: arrayResult })).toBeNull();
	});

	// test-contract: invariant — result.observation that is neither null nor a JSON object must reject the whole step.
	it("rejects a result whose observation is a string", () => {
		expect(
			parseTraceStep({ ...full, result: { outcome: "ok", observation: "not-an-object" } }),
		).toBeNull();
	});

	// test-contract: invariant — parseTraceStep must reject a non-plain-object top-level value even when it exposes every required field via custom array properties.
	it("rejects a top-level value that is an array carrying all required fields as custom properties", () => {
		const arrayValue = Object.assign(["not-a-plain-object"], {
			schema: "replay-trace.v1",
			key: { session_id: SESSION, seq: null, tool_use_id: null, ts: "t" },
			action: null,
			result: null,
			observation_ref: null,
			pre_tree: null,
			post_tree: null,
			state_ref: null,
		});
		expect(parseTraceStep(arrayValue)).toBeNull();
	});

	// test-contract: invariant — a top-level observation_ref that is neither null nor a string must reject the whole step.
	it("rejects a step whose observation_ref is a number", () => {
		expect(parseTraceStep({ ...full, observation_ref: 123 })).toBeNull();
	});

	// test-contract: invariant — a top-level pre_tree that is neither null nor a string must reject the whole step.
	it("rejects a step whose pre_tree is a number", () => {
		expect(parseTraceStep({ ...full, pre_tree: 123 })).toBeNull();
	});

	// test-contract: invariant — a top-level post_tree that is neither null nor a string must reject the whole step.
	it("rejects a step whose post_tree is a number", () => {
		expect(parseTraceStep({ ...full, post_tree: 123 })).toBeNull();
	});

	// test-contract: invariant — a top-level state_ref that is neither null nor a string must reject the whole step.
	it("rejects a step whose state_ref is a number", () => {
		expect(parseTraceStep({ ...full, state_ref: 123 })).toBeNull();
	});
});
