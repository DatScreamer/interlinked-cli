// Companion tests for src/harness/route-map/hono.ts — Phase A3.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { extractEndpoints } from "./hono.js";

const FIXTURE = join(
	__dirname,
	"..",
	"__tests__",
	"fixtures",
	"route-extraction",
	"hono",
	"app.ts",
);

describe("route-map/hono.extractEndpoints — fixture", () => {
	const content = readFileSync(FIXTURE, "utf-8");
	const endpoints = extractEndpoints(FIXTURE, content);

	it("extracts at least 5 routes", () => {
		expect(endpoints.length).toBeGreaterThanOrEqual(5);
	});

	it("tags every endpoint framework=hono", () => {
		expect(endpoints.every((e) => e.framework === "hono")).toBe(true);
	});

	it("captures inline arrow handlers", () => {
		// app.get("/health", (c) => ...) should be detected
		const health = endpoints.find((e) => e.path === "/health");
		expect(health).toBeDefined();
		expect(health?.method).toBe("GET");
	});

	it("captures named function handler symbols", () => {
		const symbolised = endpoints.filter((e) => e.handler_symbol);
		expect(symbolised.length).toBeGreaterThan(0);
	});

	it("attaches auth_chain to routes downstream of app.use(requireAuth)", () => {
		const protectedRoutes = endpoints.filter((e) => e.auth_chain.length > 0);
		expect(protectedRoutes.length).toBeGreaterThan(0);
	});

	it("derives :id path params", () => {
		const idRoute = endpoints.find((e) => e.path.includes(":id"));
		expect(idRoute?.declared_params.map((p) => p.name)).toContain("id");
	});
});

describe("route-map/hono.extractEndpoints — negative cases", () => {
	it("returns [] for plain helper modules", () => {
		expect(extractEndpoints("/x/util.ts", "export function add(a: number, b: number) { return a + b; }")).toEqual(
			[],
		);
	});

	it("ignores app.route() sub-mount calls (those are scoping, not routes)", () => {
		// .route() registers a sub-app at a prefix — not an endpoint itself.
		const src = "app.route('/admin', adminApp);";
		const out = extractEndpoints("/x/m.ts", src);
		expect(out).toEqual([]);
	});

	it("ignores commented-out routes", () => {
		expect(extractEndpoints("/x/c.ts", "// app.get('/old', handler);")).toEqual([]);
	});
});
