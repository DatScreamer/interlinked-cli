// Companion tests for src/harness/route-map/sveltekit.ts — Phase A3.

import { describe, expect, it } from "vitest";

import { extractEndpoints } from "./sveltekit.js";

describe("route-map/sveltekit.extractEndpoints", () => {
	it("extracts GET/POST from src/routes/api/users/+server.ts", () => {
		const filePath = "/abs/src/routes/api/users/+server.ts";
		const content = [
			"export async function GET() { return new Response('[]'); }",
			"export async function POST(req) { return new Response('ok'); }",
		].join("\n");
		const endpoints = extractEndpoints(filePath, content);
		expect(endpoints).toHaveLength(2);
		expect(endpoints.every((e) => e.framework === "sveltekit")).toBe(true);
		expect(endpoints.every((e) => e.path === "/api/users")).toBe(true);
	});

	it("rewrites [id] segments to :id", () => {
		const filePath = "/abs/src/routes/api/users/[id]/+server.ts";
		const content = "export async function GET() { return new Response(''); }";
		const [endpoint] = extractEndpoints(filePath, content);
		expect(endpoint.path).toBe("/api/users/:id");
		expect(endpoint.declared_params.map((p) => p.name)).toContain("id");
	});

	it("returns [] when the file is not a SvelteKit route", () => {
		expect(extractEndpoints("/abs/src/lib/util.ts", "export const x = 1;")).toEqual([]);
	});

	it("returns [] for an empty +server.ts file", () => {
		const filePath = "/abs/src/routes/api/empty/+server.ts";
		expect(extractEndpoints(filePath, "// no exports")).toEqual([]);
	});

	it("captures handler_symbol equal to the method name", () => {
		const filePath = "/abs/src/routes/api/x/+server.ts";
		const content = "export async function GET() { return new Response(''); }";
		expect(extractEndpoints(filePath, content)[0].handler_symbol).toBe("GET");
	});
});
