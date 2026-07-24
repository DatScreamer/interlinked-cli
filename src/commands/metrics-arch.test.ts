// ===========================================
// metrics-arch unit tests — pure core (dir fold → Ca/Ce/I, propagation cost)
// ===========================================
// ProjectGraph extraction is exercised via the live command; the metric math
// below is pure and tested against hand-computed oracles.

import { describe, expect, it } from "vitest";
import {
	computeDirMetrics,
	computePropagationCost,
	dirAtDepth,
	isProductionSource,
} from "./metrics-arch.js";

describe("dirAtDepth", () => {
	it("folds a path to its first N segments", () => {
		expect(dirAtDepth("src/harness/checks/foo.ts", 2)).toBe("src/harness");
		expect(dirAtDepth("src/index.ts", 2)).toBe("src");
		expect(dirAtDepth("src/harness/checks/foo.ts", 3)).toBe("src/harness/checks");
	});
});

describe("isProductionSource", () => {
	it("keeps plain source files", () => {
		expect(isProductionSource("src/harness/server.ts")).toBe(true);
	});
	it("drops test files, __tests__ dirs, and d.ts", () => {
		expect(isProductionSource("src/a/foo.test.ts")).toBe(false);
		expect(isProductionSource("src/a/__tests__/foo.ts")).toBe(false);
		expect(isProductionSource("src/types.d.ts")).toBe(false);
	});
});

describe("computeDirMetrics", () => {
	// harness/a → lib/x ; commands/b → lib/x ; commands/b → harness/a
	const EDGES = [
		{ from: "src/harness/a.ts", to: "src/lib/x.ts" },
		{ from: "src/commands/b.ts", to: "src/lib/x.ts" },
		{ from: "src/commands/b.ts", to: "src/harness/a.ts" },
	];

	it("computes Ca (files outside importing in) and Ce (files inside importing out) per dir", () => {
		const rows = computeDirMetrics(EDGES, 2);
		const lib = rows.find((r) => r.dir === "src/lib");
		// two distinct outside files import into lib; lib imports nothing
		expect(lib).toMatchObject({ ca: 2, ce: 0, instability: 0 });
		const commands = rows.find((r) => r.dir === "src/commands");
		// commands/b imports out (counted once as a file, even with 2 outward edges)
		expect(commands).toMatchObject({ ca: 0, ce: 1, instability: 1 });
		const harness = rows.find((r) => r.dir === "src/harness");
		// one outside file (commands/b) imports in; harness/a imports out
		expect(harness).toMatchObject({ ca: 1, ce: 1, instability: 0.5 });
	});

	it("ignores intra-dir edges entirely", () => {
		const rows = computeDirMetrics(
			[{ from: "src/lib/a.ts", to: "src/lib/b.ts" }],
			2,
		);
		const lib = rows.find((r) => r.dir === "src/lib");
		expect(lib).toMatchObject({ ca: 0, ce: 0, instability: null });
	});

	it("counts files per dir from both edge endpoints", () => {
		const rows = computeDirMetrics(EDGES, 2);
		expect(rows.find((r) => r.dir === "src/lib")?.files).toBe(1);
		expect(rows.find((r) => r.dir === "src/commands")?.files).toBe(1);
	});
});

describe("computePropagationCost", () => {
	it("chain a→b→c: reachable sets are 2,1,0 → cost = 3/9", () => {
		const cost = computePropagationCost([
			{ from: "a", to: "b" },
			{ from: "b", to: "c" },
		]);
		expect(cost.files).toBe(3);
		expect(cost.cost).toBeCloseTo(3 / 9, 5);
	});

	it("2-cycle: each reaches the other → 2/4", () => {
		const cost = computePropagationCost([
			{ from: "a", to: "b" },
			{ from: "b", to: "a" },
		]);
		expect(cost.cost).toBeCloseTo(0.5, 5);
	});

	it("star (hub imports 3 leaves): hub reaches 3, leaves reach 0 → 3/16", () => {
		const cost = computePropagationCost([
			{ from: "hub", to: "l1" },
			{ from: "hub", to: "l2" },
			{ from: "hub", to: "l3" },
		]);
		expect(cost.cost).toBeCloseTo(3 / 16, 5);
	});

	it("empty graph costs 0", () => {
		expect(computePropagationCost([]).cost).toBe(0);
	});
});
