// Tests for Cloudflare D1 footgun detectors.

import { describe, expect, it } from "vitest";
import { D1_FOOTGUNS } from "./d1.js";

function find(id: string) {
	const f = D1_FOOTGUNS.find((g) => g.id === id);
	if (!f) throw new Error(`footgun ${id} not registered`);
	return f;
}

describe("d1_exec_string_concat", () => {
	const fg = find("d1_exec_string_concat");

	it("fires on db.exec with template-string interpolation (SQL injection)", () => {
		const content = "await env.DB.exec(`SELECT * FROM u WHERE id = ${userId}`);";
		expect(fg.detect(content, "src/q.ts").length).toBeGreaterThan(0);
	});

	it("fires on db.exec with + string concat (SQL injection)", () => {
		const content = `await env.DB.exec("SELECT * FROM u WHERE id = " + userId);`;
		expect(fg.detect(content, "src/q.ts").length).toBeGreaterThan(0);
	});

	it("does NOT fire on db.prepare().bind().run() — parameterized safe form", () => {
		const content = `await env.DB.prepare("SELECT * FROM u WHERE id = ?").bind(userId).run();`;
		expect(fg.detect(content, "src/q.ts")).toEqual([]);
	});

	it("does NOT fire on db.exec(constant) — no user input", () => {
		const content = `await env.DB.exec("PRAGMA journal_mode = WAL");`;
		expect(fg.detect(content, "src/q.ts")).toEqual([]);
	});
});
