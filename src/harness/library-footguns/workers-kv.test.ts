// Tests for Cloudflare Workers KV footgun detectors.

import { describe, expect, it } from "vitest";
import { WORKERS_KV_FOOTGUNS } from "./workers-kv.js";

function find(id: string) {
	const f = WORKERS_KV_FOOTGUNS.find((g) => g.id === id);
	if (!f) throw new Error(`footgun ${id} not registered`);
	return f;
}

describe("workers_kv_put_no_ttl", () => {
	const fg = find("workers_kv_put_no_ttl");

	it("fires on env.KV.put(k, v) with no options object", () => {
		const content = `await env.KV.put("session:" + id, JSON.stringify(data));`;
		expect(fg.detect(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it("does NOT fire when expirationTtl is supplied", () => {
		const content = `await env.KV.put("session:" + id, JSON.stringify(data), { expirationTtl: 3600 });`;
		expect(fg.detect(content, "src/x.ts")).toEqual([]);
	});

	it("does NOT fire when expiration (absolute unix-ms) is supplied", () => {
		const content = `await env.KV.put("k", "v", { expiration: 1700000000 });`;
		expect(fg.detect(content, "src/x.ts")).toEqual([]);
	});
});

describe("workers_kv_list_no_cursor", () => {
	const fg = find("workers_kv_list_no_cursor");

	it("fires on env.KV.list() with no cursor handling in surrounding window", () => {
		const content = `
			const result = await env.KV.list();
			return result.keys.map((k) => k.name);
		`;
		expect(fg.detect(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it("does NOT fire when cursor is consulted nearby", () => {
		const content = `
			const result = await env.KV.list();
			if (!result.list_complete) {
				const next = await env.KV.list({ cursor: result.cursor });
			}
		`;
		expect(fg.detect(content, "src/x.ts")).toEqual([]);
	});
});
