// Companion tests for src/harness/route-map/shared.ts — Phase A3.
// Exercises the pure helpers reused by every per-framework adapter.

import { describe, expect, it } from "vitest";

import {
	conventionPath,
	detectExportedMethods,
	extractPathParams,
	findHandlerSymbol,
	HTTP_METHODS,
	lineNumberAt,
	makeEndpoint,
} from "./shared.js";

describe("conventionPath", () => {
	it("rewrites [id] to :id", () => {
		expect(conventionPath("users/[id]")).toBe("/users/:id");
	});

	it("rewrites [...slug] to *slug", () => {
		expect(conventionPath("blog/[...slug]")).toBe("/blog/*slug");
	});

	it("drops route groups in parens", () => {
		expect(conventionPath("(marketing)/about")).toBe("/about");
	});

	it("handles plain static segments", () => {
		expect(conventionPath("api/v1/health")).toBe("/api/v1/health");
	});
});

describe("extractPathParams", () => {
	it("extracts :id-style express params", () => {
		const params = extractPathParams("/users/:id/posts/:postId");
		expect(params.map((p) => p.name)).toEqual(["id", "postId"]);
		expect(params.every((p) => p.source === "path")).toBe(true);
	});

	it("extracts [id]-style next.js params", () => {
		expect(extractPathParams("/users/[id]").map((p) => p.name)).toEqual(["id"]);
	});

	it("extracts {id}-style FastAPI params", () => {
		expect(extractPathParams("/items/{itemId}").map((p) => p.name)).toEqual(["itemId"]);
	});

	it("extracts <id>-style python params", () => {
		expect(extractPathParams("/orders/<order_id>").map((p) => p.name)).toEqual(["order_id"]);
	});

	it("dedupes repeated names", () => {
		expect(extractPathParams("/a/:id/b/:id").map((p) => p.name)).toEqual(["id"]);
	});

	it("returns empty for static paths", () => {
		expect(extractPathParams("/health")).toEqual([]);
	});
});

describe("lineNumberAt", () => {
	it("returns 1 for offset 0", () => {
		expect(lineNumberAt("hello\nworld", 0)).toBe(1);
	});

	it("returns 2 after the first newline", () => {
		const content = "first\nsecond";
		const offset = content.indexOf("second");
		expect(lineNumberAt(content, offset)).toBe(2);
	});

	it("returns 1 for negative offset", () => {
		expect(lineNumberAt("abc", -5)).toBe(1);
	});
});

describe("findHandlerSymbol", () => {
	it("finds nearest preceding function NAME", () => {
		const src = ["function getUser() {", "  /* ... */", "}", "app.get('/u', getUser);"].join("\n");
		expect(findHandlerSymbol(src, 4)).toBe("getUser");
	});

	it("finds const NAME = arrow", () => {
		const src = ["const listOrgs = async () => { /* ... */ };", "app.get('/orgs', listOrgs);"].join(
			"\n",
		);
		expect(findHandlerSymbol(src, 2)).toBe("listOrgs");
	});

	it("finds export default function", () => {
		const src = ["export default function GET(req) {", "  return new Response('ok');", "}"].join(
			"\n",
		);
		expect(findHandlerSymbol(src, 3)).toBe("GET");
	});

	it("respects 50-line lookback cap", () => {
		const filler = Array.from({ length: 80 }, () => "// noise").join("\n");
		const src = `function farAway() {}\n${filler}\napp.get('/x', farAway);`;
		expect(findHandlerSymbol(src, 82)).toBeUndefined();
	});

	it("finds Python async def below decorator (FastAPI)", () => {
		const src = ["@app.get('/items/{id}')", "async def read_item(id: int):", "    return {}"].join(
			"\n",
		);
		expect(findHandlerSymbol(src, 1, { language: "python" })).toBe("read_item");
	});
});

describe("makeEndpoint", () => {
	it("defaults auth_chain to empty and derives params from path", () => {
		const e = makeEndpoint({
			framework: "express",
			method: "GET",
			path: "/users/:id",
			file: "/abs/handler.ts",
			line: 12,
		});
		expect(e.auth_chain).toEqual([]);
		expect(e.declared_params.map((p) => p.name)).toEqual(["id"]);
	});

	it("respects an explicit declared_params override", () => {
		const e = makeEndpoint({
			framework: "express",
			method: "POST",
			path: "/x",
			file: "/abs/x.ts",
			declared_params: [{ name: "body", source: "body" }],
		});
		expect(e.declared_params).toEqual([{ name: "body", source: "body" }]);
	});
});

describe("detectExportedMethods", () => {
	it("returns the explicit methods when present", () => {
		const src = ["export async function GET() {}", "export const POST = () => {};"].join("\n");
		expect(new Set(detectExportedMethods(src))).toEqual(new Set(["GET", "POST"]));
	});

	it("falls back to ALL when no method export is found", () => {
		expect(detectExportedMethods("// no exports here")).toEqual(["ALL"]);
	});

	it("exposes the canonical method list", () => {
		expect(HTTP_METHODS).toContain("GET");
		expect(HTTP_METHODS).toContain("DELETE");
	});
});
