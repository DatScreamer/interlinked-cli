import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHookScript } from "../hooks-template.js";
import { isJsonObject, type JsonObject } from "../json-types.js";

function parseObject(line: string): JsonObject {
	const parsed: unknown = JSON.parse(line);
	if (!isJsonObject(parsed)) throw new Error("expected a JSON object");
	return parsed;
}

function jsonl(entries: readonly unknown[]): string {
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

describe("generated transcript cost emitter", () => {
	let tempDir: string;
	let dataDir: string;
	let scriptPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "interlinked-costs-"));
		dataDir = join(tempDir, ".interlinked");
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(
			join(dataDir, "config.local.json"),
			JSON.stringify({ sync_mode: "local", agent_name: "cost-observer" }),
		);
		// Cost emission is independent of daemon recovery, which has its own
		// end-to-end suite. Record an operator stand-down so a clean checkout
		// without generated dist artifacts keeps this fixture focused and silent.
		writeFileSync(
			join(dataDir, "guard-disabled.local.json"),
			JSON.stringify({ disabled: true, scope: "project", version: 1 }),
		);
		scriptPath = join(tempDir, "hook.mjs");
		writeFileSync(scriptPath, buildHookScript("cost-emitter-test"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function runHook(client: "claude" | "codex", payload: JsonObject) {
		return spawnSync(process.execPath, [scriptPath], {
			input: JSON.stringify(payload),
			encoding: "utf-8",
			cwd: tempDir,
			env: {
				PATH: process.env.PATH ?? "",
				INTERLINKED_HOME: dataDir,
				INTERLINKED_DATA_DIR: dataDir,
				INTERLINKED_CLIENT: client,
			},
			timeout: 20_000,
		});
	}

	function readCosts(): JsonObject[] {
		return readFileSync(join(dataDir, "costs.jsonl"), "utf-8")
			.trim()
			.split("\n")
			.map(parseObject);
	}

	// test-contract: public-api — Codex cost rows are per-call deltas with raw input/cache components, never repeated cumulative totals.
	it("fails soft on a malformed cursor and emits Codex last_token_usage deltas once", () => {
		const transcriptPath = join(tempDir, "codex-rollout.jsonl");
		writeFileSync(
			transcriptPath,
			jsonl([
				{ timestamp: "2026-08-30T20:00:00Z", type: "turn_context", payload: { model: "synthetic-codex-model" } },
				{
					timestamp: "2026-08-30T20:00:01Z",
					type: "event_msg",
					payload: {
						type: "token_count",
						info: {
							last_token_usage: {
								input_tokens: 120,
								cached_input_tokens: 80,
								cache_write_input_tokens: 7,
								output_tokens: 23,
								reasoning_output_tokens: 5,
								total_tokens: 143,
							},
							total_token_usage: { input_tokens: 9_120, output_tokens: 4_023, total_tokens: 13_143 },
						},
					},
				},
				{
					timestamp: "2026-08-30T20:00:02Z",
					type: "event_msg",
					payload: { type: "token_count", info: { total_token_usage: { total_tokens: 99_999 } } },
				},
			]),
		);
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(join(dataDir, "costs-cursor.json"), "not valid json");
		const payload = {
			cwd: tempDir,
			hook_event_name: "Stop",
			session_id: "codex-root",
			transcript_path: transcriptPath,
		};

		const first = runHook("codex", payload);
		const duplicate = runHook("codex", payload);

		expect([first.status, duplicate.status]).toEqual([0, 0]);
		expect([first.stderr, duplicate.stderr]).toEqual(["", ""]);
		const rows = readCosts();
		expect(rows).toEqual([
			expect.objectContaining({
				provider: "codex",
				session_id: "codex-root",
				model: "synthetic-codex-model",
				input_tokens: 120,
				cache_read_input_tokens: 80,
				cache_creation_input_tokens: 7,
				output_tokens: 23,
				reasoning_output_tokens: 5,
				total_tokens: 143,
			}),
		]);
		expect(rows).not.toContainEqual(expect.objectContaining({ input_tokens: 9_120 }));
	});

	// test-contract: bug — sibling SubagentStop hooks share a parent session id but must retain independent transcript cursors.
	it("isolates Codex subagent cursors by actor and rollout path", () => {
		const transcriptA = join(tempDir, "child-a.jsonl");
		const transcriptB = join(tempDir, "child-b.jsonl");
		const childTranscript = jsonl([
			{ timestamp: "2026-08-30T21:00:00Z", type: "turn_context", payload: { model: "synthetic-subagent-model" } },
			{
				timestamp: "2026-08-30T21:00:01Z",
				type: "event_msg",
				payload: {
					type: "token_count",
					info: {
						last_token_usage: { input_tokens: 40, output_tokens: 6, total_tokens: 46 },
						total_token_usage: { input_tokens: 400, output_tokens: 60, total_tokens: 460 },
					},
				},
			},
		]);
		writeFileSync(transcriptA, childTranscript);
		writeFileSync(transcriptB, childTranscript);

		const resultA = runHook("codex", {
			cwd: tempDir,
			hook_event_name: "SubagentStop",
			session_id: "shared-parent",
			agent_id: "child-a",
			agent_transcript_path: transcriptA,
			transcript_path: join(tempDir, "parent.jsonl"),
		});
		const resultB = runHook("codex", {
			cwd: tempDir,
			hook_event_name: "SubagentStop",
			session_id: "shared-parent",
			agent_id: "child-b",
			agent_transcript_path: transcriptB,
			transcript_path: join(tempDir, "parent.jsonl"),
		});

		expect([resultA.status, resultB.status]).toEqual([0, 0]);
		expect(readCosts()).toEqual([
			expect.objectContaining({ provider: "codex", session_id: "shared-parent", subagent_id: "child-a" }),
			expect.objectContaining({ provider: "codex", session_id: "shared-parent", subagent_id: "child-b" }),
		]);
		const cursor = parseObject(readFileSync(join(dataDir, "costs-cursor.json"), "utf-8"));
		expect(Object.keys(cursor)).toHaveLength(2);
	});

	// test-contract: public-api — extending the emitter for Codex must retain Claude assistant-message usage semantics.
	it("preserves Claude assistant usage rows", () => {
		const transcriptPath = join(tempDir, "claude-transcript.jsonl");
		writeFileSync(
			transcriptPath,
			jsonl([
				{
					timestamp: "2026-08-30T22:00:00Z",
					type: "assistant",
					uuid: "claude-message",
					message: {
						id: "msg-1",
						model: "fixture-model",
						stop_reason: "end_turn",
						usage: {
							input_tokens: 12,
							output_tokens: 8,
							cache_read_input_tokens: 90,
							cache_creation_input_tokens: 3,
						},
					},
				},
			]),
		);

		const result = runHook("claude", {
			cwd: tempDir,
			hook_event_name: "Stop",
			session_id: "claude-root",
			transcript_path: transcriptPath,
		});

		expect(result.status, result.stderr).toBe(0);
		expect(readCosts()).toEqual([
			expect.objectContaining({
				provider: "claude-code",
				session_id: "claude-root",
				message_id: "msg-1",
				model: "fixture-model",
				input_tokens: 12,
				output_tokens: 8,
				cache_read_input_tokens: 90,
				cache_creation_input_tokens: 3,
				stop_reason: "end_turn",
			}),
		]);
		const cursor = parseObject(readFileSync(join(dataDir, "costs-cursor.json"), "utf-8"));
		expect(cursor).toHaveProperty("claude-root");
	});
});
