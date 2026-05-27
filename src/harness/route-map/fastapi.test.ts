// Companion tests for src/harness/route-map/fastapi.ts — Phase A3.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { extractEndpoints } from "./fastapi.js";

const FIXTURE = join(
	__dirname,
	"..",
	"__tests__",
	"fixtures",
	"route-extraction",
	"fastapi",
	"main.py",
);

describe("route-map/fastapi.extractEndpoints — fixture", () => {
	const content = readFileSync(FIXTURE, "utf-8");
	const endpoints = extractEndpoints(FIXTURE, content);

	it("extracts at least 5 routes", () => {
		expect(endpoints.length).toBeGreaterThanOrEqual(5);
	});

	it("tags every endpoint framework=fastapi", () => {
		expect(endpoints.every((e) => e.framework === "fastapi")).toBe(true);
	});

	it("captures GET / POST / DELETE methods", () => {
		const methods = new Set(endpoints.map((e) => e.method));
		expect(methods.has("GET")).toBe(true);
		expect(methods.has("POST")).toBe(true);
		expect(methods.has("DELETE")).toBe(true);
	});

	it("converts {id}-style path params to declared_params", () => {
		const idRoute = endpoints.find((e) => e.path.includes("{item_id}"));
		expect(idRoute).toBeDefined();
		expect(idRoute?.declared_params.map((p) => p.name)).toContain("item_id");
	});

	it("captures handler_symbol from `def NAME(` below the decorator", () => {
		const itemRead = endpoints.find((e) => e.path === "/items/{item_id}");
		expect(itemRead?.handler_symbol).toBe("read_item");
	});

	it("attaches a Depends auth_chain entry for Depends(get_current_user)", () => {
		const protectedRoutes = endpoints.filter((e) =>
			e.auth_chain.some((c) => c.kind === "depends" && c.name === "get_current_user"),
		);
		expect(protectedRoutes.length).toBeGreaterThan(0);
	});

	it("attaches Depends from route-level dependencies=[]", () => {
		const orderRead = endpoints.find((e) => e.path === "/orders/{order_id}" && e.method === "GET");
		expect(orderRead?.auth_chain.length).toBeGreaterThan(0);
	});
});

describe("route-map/fastapi.extractEndpoints — negative cases", () => {
	it("returns [] for a plain Python module with no decorators", () => {
		const src = "def helper(): return 1";
		expect(extractEndpoints("/x/helper.py", src)).toEqual([]);
	});

	it("ignores Python class methods that look like decorators", () => {
		const src = "@property\ndef name(self): return self._name";
		expect(extractEndpoints("/x/m.py", src)).toEqual([]);
	});

	it("ignores commented-out routes", () => {
		const src = "# @app.get('/old')\n# def handler(): return 1";
		expect(extractEndpoints("/x/c.py", src)).toEqual([]);
	});
});
