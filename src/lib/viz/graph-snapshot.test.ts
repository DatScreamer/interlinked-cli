// Tests for buildGraphSnapshot — the RAM-light topology the dashboard renders.
// Builds a real ProjectGraph over a tiny temp project (no mocks) and asserts
// the projected node/edge/role shape, so the test exercises the real SUT.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProjectGraph } from "../../harness/project-graph.js";
import { buildGraphSnapshot, groupOf, type VizGraphSnapshot } from "./graph-snapshot.js";

describe("groupOf", () => {
	it("uses the first path segment as the subsystem group", () => {
		expect(groupOf("lib/viz/server.ts")).toBe("lib");
		expect(groupOf("harness/checks/x.ts")).toBe("harness");
	});

	it("groups a top-level file under root", () => {
		expect(groupOf("index.ts")).toBe("root");
	});
});

describe("buildGraphSnapshot", () => {
	let dir: string;
	let snap: VizGraphSnapshot;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "viz-snap-"));
		// a <- b, a <- c, b <- c, and d imports a twice (type-only + value).
		writeFileSync(join(dir, "a.ts"), "export const X = 1;\n");
		writeFileSync(join(dir, "b.ts"), 'import { X } from "./a.js";\nexport function useB() {\n\treturn X;\n}\n');
		writeFileSync(
			join(dir, "c.ts"),
			'import { X } from "./a.js";\nimport { useB } from "./b.js";\nexport const c = useB() + X;\n',
		);
		writeFileSync(
			join(dir, "d.ts"),
			'import type { X } from "./a.js";\nimport { X as X2 } from "./a.js";\nexport const d: X = X2;\n',
		);
		const graph = new ProjectGraph(dir);
		graph.initialize();
		snap = buildGraphSnapshot(graph, "testroot");
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("captures every indexed file as a node", () => {
		expect(snap.node_count).toBe(4);
		const ids = snap.nodes.map((n) => n.id).sort();
		expect(ids).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
	});

	it("tags each top-level node with the root subsystem group", () => {
		// The fixture files are all top-level (no path segment), so group is "root".
		expect(snap.nodes.every((n) => n.group === "root")).toBe(true);
	});

	it("classifies module roles from dependent counts", () => {
		const roleOf = (id: string) => snap.nodes.find((n) => n.id === id)?.role;
		expect(roleOf("a.ts")).toBe("root"); // depended upon, imports nothing
		expect(roleOf("b.ts")).toBe("internal"); // 1 dependent, imports a
		expect(roleOf("c.ts")).toBe("leaf"); // nothing depends on it
		expect(snap.roles).toEqual({ hub: 0, root: 1, internal: 1, leaf: 2 });
	});

	it("names the most-depended-upon cell as the stem (super_hub)", () => {
		expect(snap.super_hub).toEqual({ id: "a.ts", dependents: 3 });
	});

	it("dedupes a doubly-imported pair into one value edge", () => {
		const dToA = snap.edges.filter((e) => e.from === "d.ts" && e.to === "a.ts");
		expect(dToA).toHaveLength(1);
		expect(dToA[0]?.typeOnly).toBe(false); // a value import collapses the pair
	});

	it("draws one edge per resolved import pair", () => {
		const keys = snap.edges.map((e) => `${e.from}->${e.to}`).sort();
		expect(keys).toEqual(["b.ts->a.ts", "c.ts->a.ts", "c.ts->b.ts", "d.ts->a.ts"]);
		expect(snap.edge_count).toBe(4);
	});

	it("carries the root label and an ISO timestamp", () => {
		expect(snap.root).toBe("testroot");
		expect(snap.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
	});
});
