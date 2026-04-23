// Smoke tests for project-graph/interface-bodies.ts.

import { describe, expect, it } from "vitest";
import { extractInterfaceBodies } from "./interface-bodies.js";

describe("interface-bodies (smoke)", () => {
	it("exports extractInterfaceBodies", () => {
		expect(typeof extractInterfaceBodies).toBe("function");
	});

	it("returns an empty map when no interfaces are declared", () => {
		expect(extractInterfaceBodies("const x = 1").size).toBe(0);
	});

	it("captures a simple interface body keyed by name", () => {
		const code = ["export interface User {", "  id: string", "  name: string", "}"].join("\n");
		const bodies = extractInterfaceBodies(code);
		expect(bodies.has("User")).toBe(true);
		expect(bodies.get("User")).toContain("id: string");
	});

	it("captures an inline object type alias", () => {
		const code = ["export type Point = {", "  x: number", "  y: number", "}"].join("\n");
		const bodies = extractInterfaceBodies(code);
		expect(bodies.has("Point")).toBe(true);
	});
});
