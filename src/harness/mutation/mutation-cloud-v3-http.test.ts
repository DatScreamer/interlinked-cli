// test-contract: untrusted cloud responses are bounded before allocation and
// diagnostics never echo credentials.

import { describe, expect, it } from "vitest";
import {
	boundedErrorBody,
	readBoundedBytes,
	readBoundedJson,
} from "./mutation-cloud-v3-http.js";

describe("bounded mutation-cloud HTTP bodies", () => {
	it("rejects an oversized declared body before pulling its stream", async () => {
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					pulls += 1;
					controller.enqueue(new Uint8Array(1));
					controller.close();
				},
			},
			// Prevent the stream constructor from prefetching before production
			// code has a chance to reject the declared Content-Length.
			{ highWaterMark: 0 },
		);
		const response = new Response(body, { headers: { "content-length": "10" } });
		await expect(readBoundedBytes(response, 5, "fixture body")).rejects.toThrow("5-byte");
		expect(pulls).toBe(0);
	});

	it("cancels a chunked body when it crosses the limit", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3]));
				controller.enqueue(new Uint8Array([4, 5, 6]));
			},
			cancel() {
				cancelled = true;
			},
		});
		await expect(readBoundedBytes(new Response(body), 5, "fixture body")).rejects.toThrow("5-byte");
		expect(cancelled).toBe(true);
	});

	it("parses bounded JSON without using Response.json", async () => {
		await expect(readBoundedJson(new Response('{"ok":true}'), "fixture JSON", 32)).resolves.toEqual({ ok: true });
	});

	it("redacts exact and generic credentials from bounded error text", async () => {
		const body = JSON.stringify({
			token: "server-echo",
			detail: "Bearer other-secret exact-secret",
		});
		const message = await boundedErrorBody(new Response(body), ["exact-secret"]);
		expect(message).not.toContain("exact-secret");
		expect(message).not.toContain("other-secret");
		expect(message).not.toContain("server-echo");
		expect(message).toContain("[REDACTED]");
	});
});
