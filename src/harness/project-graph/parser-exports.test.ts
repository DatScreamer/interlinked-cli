// Smoke tests for project-graph/parser-exports.ts.
// Behavior is covered by src/harness/__tests__/project-graph.test.ts via
// ProjectGraph.getExports; these tests verify the extracted function is
// reachable on its own and produces the expected shape.

import { describe, expect, it } from "vitest";
import { parseExports } from "./parser-exports.js";

describe("parser-exports (smoke)", () => {
	it("exports a function", () => {
		expect(typeof parseExports).toBe("function");
	});

	it("returns an empty array for empty input", () => {
		expect(parseExports("")).toEqual([]);
	});

	it("extracts a named function export with line number and kind", () => {
		const code = ["// header", "export function foo() {}", ""].join("\n");
		const out = parseExports(code);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ name: "foo", kind: "function", line: 2, isTypeOnly: false });
	});

	it("marks interface/type exports as type-only", () => {
		const out = parseExports(
			["export interface User { id: string }", "export type Id = string"].join("\n"),
		);
		const names = out.map((e) => ({ name: e.name, isTypeOnly: e.isTypeOnly }));
		expect(names).toEqual([
			{ name: "User", isTypeOnly: true },
			{ name: "Id", isTypeOnly: true },
		]);
	});
});
