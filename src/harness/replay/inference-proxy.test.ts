// G1 pass-through proxy — integration against a mock upstream: SSE responses
// stream to the client unmodified while the tee reassembles + captures an
// envelope; JSON responses capture directly; non-/v1/messages traffic passes
// through uncaptured; upstream failure returns 502 without crashing capture
// (docs/design/reproducibility/g1-inference-capture.md).

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInferenceProxy, type InferenceProxy, shouldCapture } from "./inference-proxy.js";
import { loadEnvelopes, pendingEnvelopePath } from "./inference-store.js";

const cleanups: Array<() => void> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) fn();
});

function tempReplayDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "il-proxy-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const SSE_BODY: string = [
	'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_p","model":"m","usage":{"input_tokens":10}}}\n\n',
	'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_prx","name":"Read","input":{}}}\n\n',
	'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"p\\":1}"}}\n\n',
	'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
	'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}\n\n',
	'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

function listen(server: Server): Promise<string> {
	return new Promise((resolveUrl) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			cleanups.push(() => server.close());
			resolveUrl(`http://127.0.0.1:${port}`);
		});
	});
}

async function startMockUpstream(): Promise<string> {
	const server = createServer((req, res) => {
		if (req.method === "POST" && req.url?.startsWith("/v1/messages")) {
			res.writeHead(200, { "content-type": "text/event-stream" });
			// Two flushes so the proxy sees a chunk boundary mid-stream.
			res.write(SSE_BODY.slice(0, 120));
			setTimeout(() => {
				res.end(SSE_BODY.slice(120));
			}, 10);
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true, path: req.url }));
	});
	return listen(server);
}

async function startProxy(upstreamUrl: string, replayDir: string): Promise<InferenceProxy> {
	const proxy = await createInferenceProxy({
		port: 0,
		upstreamUrl,
		replayDir,
		log: () => undefined,
	});
	cleanups.push(() => proxy.close());
	return proxy;
}

describe("shouldCapture — the capture contract", () => {
	it("captures POST /v1/messages (with or without query)", () => {
		expect(shouldCapture("POST", "/v1/messages")).toBe(true);
		expect(shouldCapture("POST", "/v1/messages?beta=true")).toBe(true);
	});

	it("does not capture sub-paths, other endpoints, or non-POST", () => {
		expect(shouldCapture("POST", "/v1/messages/count_tokens")).toBe(false);
		expect(shouldCapture("POST", "/v1/messages/batches")).toBe(false);
		expect(shouldCapture("GET", "/v1/messages")).toBe(false);
		expect(shouldCapture("POST", "/v1/models")).toBe(false);
	});
});

describe("createInferenceProxy", () => {
	it("streams SSE through unmodified and captures a reassembled envelope", async () => {
		const replayDir = tempReplayDir();
		const upstream = await startMockUpstream();
		const proxy = await startProxy(upstream, replayDir);

		const resp = await fetch(`${proxy.url}/v1/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": "sk-secret-never-persist",
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "go" }], max_tokens: 8 }),
		});
		const text = await resp.text();
		expect(resp.status).toBe(200);
		expect(text).toBe(SSE_BODY);

		const envelopes = loadEnvelopes(pendingEnvelopePath(replayDir));
		expect(envelopes).toHaveLength(1);
		const env = envelopes[0];
		expect(env?.tool_use_ids).toEqual(["toolu_prx"]);
		expect(env?.response.stop_reason).toBe("tool_use");
		expect(env?.request.model).toBe("m");
		expect(env?.request.params).toEqual({ max_tokens: 8 });
		expect(JSON.stringify(env?.request_headers)).not.toContain("sk-secret");
		expect(env?.request_headers["anthropic-version"]).toBe("2023-06-01");
	});

	it("captures non-streaming JSON message responses too", async () => {
		const replayDir = tempReplayDir();
		const upstream = await listen(
			createServer((_req, res) => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						id: "msg_json",
						stop_reason: "end_turn",
						content: [{ type: "text", text: "hi" }],
					}),
				);
			}),
		);
		const proxy = await startProxy(upstream, replayDir);
		const resp = await fetch(`${proxy.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "m", messages: [] }),
		});
		expect((await resp.json()).id).toBe("msg_json");
		const envelopes = loadEnvelopes(pendingEnvelopePath(replayDir));
		expect(envelopes).toHaveLength(1);
		expect(envelopes[0]?.response.id).toBe("msg_json");
		expect(envelopes[0]?.tool_use_ids).toEqual([]);
	});

	it("passes non-/v1/messages traffic through without capturing", async () => {
		const replayDir = tempReplayDir();
		const upstream = await startMockUpstream();
		const proxy = await startProxy(upstream, replayDir);
		const resp = await fetch(`${proxy.url}/v1/models`, { method: "GET" });
		expect((await resp.json()).ok).toBe(true);
		expect(loadEnvelopes(pendingEnvelopePath(replayDir))).toEqual([]);
	});

	it("does not capture count_tokens (a /v1/messages sub-path)", async () => {
		const replayDir = tempReplayDir();
		const upstream = await startMockUpstream();
		const proxy = await startProxy(upstream, replayDir);
		await fetch(`${proxy.url}/v1/messages/count_tokens`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "m", messages: [] }),
		});
		expect(loadEnvelopes(pendingEnvelopePath(replayDir))).toEqual([]);
	});

	it("returns 502 when the upstream is unreachable", async () => {
		const replayDir = tempReplayDir();
		const proxy = await startProxy("http://127.0.0.1:9", replayDir);
		const resp = await fetch(`${proxy.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "m", messages: [] }),
		});
		expect(resp.status).toBe(502);
		expect(loadEnvelopes(pendingEnvelopePath(replayDir))).toEqual([]);
	});
});
