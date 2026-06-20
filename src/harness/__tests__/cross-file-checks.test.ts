import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkCrossFileSwitchDiscriminant,
	checkSingleImplementationInterface,
} from "../cross-file-checks.js";
import type { ProjectGraph } from "../project-graph.js";
import type { ExportedSymbol } from "../types.js";
import { nonNull } from "../../lib/non-null.js";

// Minimal fake ProjectGraph — implements only the methods the checks call.
function makeGraph(
	files: string[],
	exportsByFile: Record<string, ExportedSymbol[]> = {},
): {
	allFiles: () => string[];
	toRelative: (p: string) => string;
	getExports: (p: string) => ExportedSymbol[];
} {
	return {
		allFiles: () => files,
		toRelative: (p: string) => p.split("/").slice(-2).join("/"),
		getExports: (p: string) => exportsByFile[p] ?? [],
	};
}

describe("checkCrossFileSwitchDiscriminant", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "xfile-switch-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("flags the edited file when the same discriminant appears elsewhere", () => {
		const a = join(dir, "a.ts");
		const b = join(dir, "b.ts");
		writeFileSync(a, "function f(x) { switch (x.kind) { case 'A': return 1; } }");
		writeFileSync(b, "function g(x) { switch (x.kind) { case 'B': return 2; } }");
		const graph = makeGraph([a, b]);
		const results = checkCrossFileSwitchDiscriminant(
			a,
			"a.ts",
			graph as unknown as ProjectGraph,
		);
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).check).toBe("cross_file_switch_discriminant");
	});

	it("does not flag when discriminant appears only in the edited file", () => {
		const a = join(dir, "a.ts");
		const b = join(dir, "b.ts");
		writeFileSync(a, "function f(x) { switch (x.kind) { case 'A': return 1; } }");
		writeFileSync(b, "function g() { return 2; }");
		const graph = makeGraph([a, b]);
		expect(
			checkCrossFileSwitchDiscriminant(a, "a.ts", graph as unknown as ProjectGraph),
		).toEqual([]);
	});

	it("ignores discriminants that do not end in kind/type/tag/variant", () => {
		const a = join(dir, "a.ts");
		const b = join(dir, "b.ts");
		writeFileSync(a, "switch (x.status) { case 1: break; }");
		writeFileSync(b, "switch (x.status) { case 2: break; }");
		const graph = makeGraph([a, b]);
		expect(
			checkCrossFileSwitchDiscriminant(a, "a.ts", graph as unknown as ProjectGraph),
		).toEqual([]);
	});
});

describe("checkSingleImplementationInterface", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "single-impl-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("flags interface with exactly one implementor", () => {
		const iface = join(dir, "shape.ts");
		const impl = join(dir, "square.ts");
		writeFileSync(iface, "export interface Shape { area(): number; }");
		writeFileSync(
			impl,
			"import type { Shape } from './shape'; class Square implements Shape { area() { return 4; } }",
		);
		const graph = makeGraph([iface, impl], {
			[iface]: [{ name: "Shape", kind: "interface", isTypeOnly: false, line: 1 }],
		});
		const results = checkSingleImplementationInterface(
			iface,
			"shape.ts",
			graph as unknown as ProjectGraph,
		);
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).check).toBe("single_implementation_interface");
	});

	it("passes interface with multiple implementors", () => {
		const iface = join(dir, "shape.ts");
		const a = join(dir, "a.ts");
		const b = join(dir, "b.ts");
		writeFileSync(iface, "export interface Shape { area(): number; }");
		writeFileSync(a, "class A implements Shape { area() { return 1; } }");
		writeFileSync(b, "class B implements Shape { area() { return 2; } }");
		const graph = makeGraph([iface, a, b], {
			[iface]: [{ name: "Shape", kind: "interface", isTypeOnly: false, line: 1 }],
		});
		expect(
			checkSingleImplementationInterface(iface, "shape.ts", graph as unknown as ProjectGraph),
		).toEqual([]);
	});

	it("passes interface with zero implementors", () => {
		const iface = join(dir, "shape.ts");
		writeFileSync(iface, "export interface Shape { area(): number; }");
		const graph = makeGraph([iface], {
			[iface]: [{ name: "Shape", kind: "interface", isTypeOnly: false, line: 1 }],
		});
		expect(
			checkSingleImplementationInterface(iface, "shape.ts", graph as unknown as ProjectGraph),
		).toEqual([]);
	});
});
