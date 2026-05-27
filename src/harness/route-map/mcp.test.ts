// Companion tests for src/harness/route-map/mcp.ts — Phase A3.
// MCP is not an HTTP framework; it follows the same "named handler"
// shape we use to express HTTP routes, so the extractor treats
// server.tool(...) calls as endpoints with method = "TOOL".

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { extractEndpoints } from "./mcp.js";

const FIXTURE = join(
	__dirname,
	"..",
	"__tests__",
	"fixtures",
	"route-extraction",
	"mcp",
	"server.ts",
);

describe("route-map/mcp.extractEndpoints — fixture", () => {
	const content = readFileSync(FIXTURE, "utf-8");
	const endpoints = extractEndpoints(FIXTURE, content);

	it("extracts every server.tool(...) call", () => {
		expect(endpoints.length).toBeGreaterThanOrEqual(5);
	});

	it("tags every endpoint framework=mcp and method=TOOL", () => {
		expect(endpoints.every((e) => e.framework === "mcp")).toBe(true);
		expect(endpoints.every((e) => e.method === "TOOL")).toBe(true);
	});

	it("uses the tool name as the path", () => {
		const names = endpoints.map((e) => e.path);
		expect(names).toContain("search_files");
		expect(names).toContain("read_file");
	});

	it("captures a line number per tool", () => {
		expect(endpoints.every((e) => typeof e.line === "number" && e.line >= 1)).toBe(true);
	});

	it("leaves auth_chain empty (MCP has no upstream auth-middleware)", () => {
		expect(endpoints.every((e) => e.auth_chain.length === 0)).toBe(true);
	});
});

describe("route-map/mcp.extractEndpoints — negative cases", () => {
	it("returns [] for a non-MCP file", () => {
		expect(extractEndpoints("/x/util.ts", "export const x = 1;")).toEqual([]);
	});

	it("ignores commented-out server.tool calls", () => {
		expect(extractEndpoints("/x/c.ts", "// server.tool('old', schema, handler);")).toEqual([]);
	});

	it("ignores strings that merely contain server.tool syntax", () => {
		const src = "const docs = 'use server.tool(...) like this';";
		expect(extractEndpoints("/x/d.ts", src)).toEqual([]);
	});
});
