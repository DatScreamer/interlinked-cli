// Tests for the redis footgun detectors.

import { describe, expect, it } from "vitest";
import { REDIS_FOOTGUNS } from "./redis.js";

function find(id: string) {
	const f = REDIS_FOOTGUNS.find((g) => g.id === id);
	if (!f) throw new Error(`footgun ${id} not registered`);
	return f;
}

describe("redis_set_without_expire", () => {
	const fg = find("redis_set_without_expire");

	it("fires on bare client.set(key, value)", () => {
		const content = `
			await redis.set("user:123", JSON.stringify(user));
		`;
		expect(fg.detect(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it("does NOT fire when EX option is supplied", () => {
		const content = `await redis.set("user:123", "v", { EX: 3600 });`;
		expect(fg.detect(content, "src/x.ts")).toEqual([]);
	});

	it("does NOT fire when third positional arg is supplied (legacy ioredis form)", () => {
		const content = `await redis.set("k", "v", "EX", 60);`;
		expect(fg.detect(content, "src/x.ts")).toEqual([]);
	});

	it("does NOT fire on test files", () => {
		const content = `await redis.set("k", "v");`;
		expect(fg.detect(content, "src/x.test.ts")).toEqual([]);
	});
});
