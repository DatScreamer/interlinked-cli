// `interlinked replay` command — pins the status collector (envelope counts
// the operator sees) and the capture-instructions payload (the exact env the
// runner needs). Actions print; the logic lives in exported pure helpers.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendEnvelope, type InferenceEnvelope } from "../harness/replay/inference-store.js";
import { buildCaptureInstructions, collectReplayStatus } from "./replay.js";

const cleanups: string[] = [];
afterEach(() => {
	for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempReplayDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "il-replay-cmd-"));
	cleanups.push(dir);
	return dir;
}

function envelope(overrides: Partial<InferenceEnvelope>): InferenceEnvelope {
	return {
		schema: "inference-envelope.v1",
		request_index: 1,
		ts_request: "2026-07-24T12:00:00.000Z",
		ts_response: "2026-07-24T12:00:01.000Z",
		latency_ms: 1000,
		provider: "anthropic",
		request_headers: {},
		request: { model: "m", messages: [] },
		response: { id: "msg", content: [] },
		tool_use_ids: [],
		request_sha256: "0".repeat(64),
		session_id: null,
		seq: null,
		...overrides,
	};
}

describe("collectReplayStatus", () => {
	it("reports zeros for an empty capture dir", () => {
		const status = collectReplayStatus(tempReplayDir());
		expect(status).toEqual({
			envelope_count: 0,
			tool_turn_count: 0,
			latest_ts: null,
		});
	});

	it("counts envelopes, tool-bearing turns, and the latest response ts", () => {
		const dir = tempReplayDir();
		appendEnvelope(dir, envelope({ request_index: 1, tool_use_ids: ["toolu_1"] }));
		appendEnvelope(
			dir,
			envelope({ request_index: 2, ts_response: "2026-07-24T12:05:00.000Z" }),
		);
		const status = collectReplayStatus(dir);
		expect(status.envelope_count).toBe(2);
		expect(status.tool_turn_count).toBe(1);
		expect(status.latest_ts).toBe("2026-07-24T12:05:00.000Z");
	});
});

describe("buildCaptureInstructions", () => {
	it("names the dist entry, the replay dir, and the base-url export", () => {
		const text = buildCaptureInstructions("/repo");
		expect(text).toContain("dist/harness/replay/inference-proxy.js");
		expect(text).toContain(join("/repo", ".interlinked", "replay"));
		expect(text).toContain("ANTHROPIC_BASE_URL");
	});
});
