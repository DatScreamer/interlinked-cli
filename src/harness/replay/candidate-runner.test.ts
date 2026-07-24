// T1 candidate runner — sends a captured envelope's EXACT observation to a
// candidate model and returns its proposed action. Pins the two documented
// transforms (docs/design/reproducibility/tier1-teacher-forced-eval.md):
// prior-turn thinking blocks are stripped by default (mirrors the API's own
// cross-model semantics), and the model id is replaced while every other
// parameter rides along verbatim. Verified against a mock upstream.

import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../../lib/json-types.js";
import type { InferenceEnvelope } from "./inference-store.js";
import {
	buildCandidateRequest,
	extractProposedAction,
	runCandidate,
	stripPriorThinking,
} from "./candidate-runner.js";

function envelope(): InferenceEnvelope {
	return {
		schema: "inference-envelope.v1",
		request_index: 1,
		ts_request: "t0",
		ts_response: "t1",
		latency_ms: 1,
		provider: "anthropic",
		request_headers: { "anthropic-version": "2023-06-01" },
		request: {
			model: "reference-model",
			system: "be exact",
			tools: [{ name: "Bash" }],
			messages: [
				{ role: "user", content: "go" },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "private", signature: "s" },
						{ type: "text", text: "ok" },
					],
				},
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_0", content: "done" }] },
			],
			params: { max_tokens: 64, stream: true },
		},
		response: { id: "msg_ref", content: [] },
		tool_use_ids: [],
		request_sha256: "0".repeat(64),
		session_id: "sess",
		seq: 5,
	};
}

describe("stripPriorThinking", () => {
	it("removes thinking blocks from assistant turns, keeps everything else", () => {
		const stripped = stripPriorThinking(envelope().request.messages as JsonObject[]);
		const assistant = stripped[1] as JsonObject;
		expect(assistant.content).toEqual([{ type: "text", text: "ok" }]);
		expect(stripped[0]).toEqual({ role: "user", content: "go" });
		expect(stripped).toHaveLength(3);
	});
});

describe("buildCandidateRequest", () => {
	it("swaps the model, strips thinking, forces non-streaming, keeps params", () => {
		const body = buildCandidateRequest(envelope(), "candidate-y", {});
		expect(body.model).toBe("candidate-y");
		expect(body.system).toBe("be exact");
		expect(body.tools).toEqual([{ name: "Bash" }]);
		expect(body.max_tokens).toBe(64);
		expect(body.stream).toBeUndefined();
		const assistant = (body.messages as JsonObject[])[1] as JsonObject;
		expect(JSON.stringify(assistant)).not.toContain("thinking");
	});

	it("keeps thinking blocks when keepThinking is set", () => {
		const body = buildCandidateRequest(envelope(), "candidate-y", { keepThinking: true });
		expect(JSON.stringify(body.messages)).toContain("thinking");
	});
});

describe("extractProposedAction", () => {
	it("returns the first tool_use block as the action", () => {
		const action = extractProposedAction([
			{ type: "text", text: "I will read" },
			{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } },
		]);
		expect(action).toEqual({ tool: "Read", input: { file_path: "/x" } });
	});

	it("returns a null action for text-only responses", () => {
		expect(extractProposedAction([{ type: "text", text: "done" }])).toEqual({
			tool: null,
			input: null,
		});
	});
});

describe("runCandidate (mock upstream)", () => {
	it("POSTs the transformed request with auth and returns the proposal", async () => {
		let seenBody: JsonObject | null = null;
		let seenKey: string | undefined;
		const server = createServer((req, res) => {
			seenKey = req.headers["x-api-key"] as string | undefined;
			const chunks: Buffer[] = [];
			req.on("data", (c: Buffer) => chunks.push(c));
			req.on("end", () => {
				seenBody = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as JsonObject;
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						id: "msg_cand",
						stop_reason: "tool_use",
						content: [{ type: "tool_use", id: "t9", name: "Bash", input: { command: "ls" } }],
					}),
				);
			});
		});
		const url: string = await new Promise((resolveUrl) => {
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address();
				resolveUrl(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`);
			});
		});
		try {
			const result = await runCandidate({
				envelope: envelope(),
				model: "candidate-y",
				baseUrl: url,
				apiKey: "sk-test",
			});
			expect(seenKey).toBe("sk-test");
			expect((seenBody as JsonObject | null)?.model).toBe("candidate-y");
			expect(result.stop_reason).toBe("tool_use");
			expect(result.proposed).toEqual({ tool: "Bash", input: { command: "ls" } });
		} finally {
			server.close();
		}
	});
});
