// Companion tests for src/harness/route-map/express.ts — Phase A3.
// One realistic fixture, plus positive and negative cases for the
// Express call-site recognizer.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { extractEndpoints } from "./express.js";

const FIXTURE = join(
	__dirname,
	"..",
	"__tests__",
	"fixtures",
	"route-extraction",
	"express",
	"server.ts",
);

describe("route-map/express.extractEndpoints — fixture", () => {
	const content = readFileSync(FIXTURE, "utf-8");
	const endpoints = extractEndpoints(FIXTURE, content);

	it("extracts at least 5 routes from the fixture", () => {
		expect(endpoints.length).toBeGreaterThanOrEqual(5);
	});

	it("tags every endpoint with framework=express", () => {
		expect(endpoints.every((e) => e.framework === "express")).toBe(true);
	});

	it("captures HTTP methods as uppercase", () => {
		const methods = new Set(endpoints.map((e) => e.method));
		expect(methods.has("GET")).toBe(true);
		expect(methods.has("POST")).toBe(true);
	});

	it("captures handler_symbol when defined as a named function nearby", () => {
		const withSymbol = endpoints.filter((e) => e.handler_symbol);
		expect(withSymbol.length).toBeGreaterThan(0);
	});

	it("captures path params for :id-style routes", () => {
		const idRoute = endpoints.find((e) => e.path.includes(":id"));
		expect(idRoute).toBeDefined();
		expect(idRoute?.declared_params.map((p) => p.name)).toContain("id");
	});

	it("includes a non-empty auth_chain on at least one route", () => {
		const protectedRoutes = endpoints.filter((e) => e.auth_chain.length > 0);
		expect(protectedRoutes.length).toBeGreaterThan(0);
	});

	it("attaches a 1-indexed line number to every endpoint", () => {
		expect(endpoints.every((e) => typeof e.line === "number" && e.line >= 1)).toBe(true);
	});
});

describe("route-map/express.extractEndpoints — negative cases", () => {
	it("skips non-router .use() calls", () => {
		const src = ["const router = express.Router();", "router.use(express.json());"].join("\n");
		const out = extractEndpoints("/x/router.ts", src);
		expect(out.filter((e) => e.method !== "USE").length).toBe(0);
	});

	it("returns [] for a file with no route calls", () => {
		const src = "export function helper() { return 42; }";
		expect(extractEndpoints("/x/helper.ts", src)).toEqual([]);
	});

	it("ignores commented-out routes", () => {
		const src = "// app.get('/old', handler);\nconst x = 1;";
		expect(extractEndpoints("/x/c.ts", src)).toEqual([]);
	});

	it("ignores strings that merely contain app.get syntax", () => {
		const src = 'const docs = "use app.get(\'/x\', handler) like this";';
		expect(extractEndpoints("/x/d.ts", src)).toEqual([]);
	});
});
