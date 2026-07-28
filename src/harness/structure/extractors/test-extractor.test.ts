import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import { extract, metadata } from "./test-extractor.js";

describe("test-extractor", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "test-ext-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("exposes the expected metadata", () => {
		expect(metadata.name).toBe("test-extractor");
		expect(metadata.output_kinds).toEqual(["test"]);
		expect(metadata.max_determinism).toBe("heuristic");
	});

	it("discovers .test.ts, .spec.ts, *_test.go, *_test.py, test_*.py", () => {
		writeFileSync(join(tmp, "a.test.ts"), "");
		writeFileSync(join(tmp, "b.spec.ts"), "");
		writeFileSync(join(tmp, "c_test.go"), "");
		writeFileSync(join(tmp, "d_test.py"), "");
		writeFileSync(join(tmp, "test_e.py"), "");
		writeFileSync(join(tmp, "app.ts"), ""); // not a test

		const { nodes } = extract(tmp);
		const labels = nodes.map((n) => n.label).sort();
		expect(labels).toEqual(["a.test.ts", "b.spec.ts", "c_test.go", "d_test.py", "test_e.py"]);
	});

	it("treats files under __tests__/ as tests regardless of filename", () => {
		mkdirSync(join(tmp, "__tests__"), { recursive: true });
		writeFileSync(join(tmp, "__tests__", "foo.ts"), "");
		const { nodes } = extract(tmp);
		expect(nodes.some((n) => n.label === "__tests__/foo.ts")).toBe(true);
	});

	it("creates a `tests` edge pointing from test → inferred module", () => {
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(join(tmp, "src", "foo.test.ts"), "");
		const { nodes, edges } = extract(tmp);
		expect(nodes).toHaveLength(1);
		expect(edges).toHaveLength(1);
		expect(nonNull(edges[0]).kind).toBe("tests");
		expect(nonNull(edges[0]).from).toContain("foo");
	});

	it("skips node_modules", () => {
		mkdirSync(join(tmp, "node_modules", "lib"), { recursive: true });
		writeFileSync(join(tmp, "node_modules", "lib", "a.test.ts"), "");
		const { nodes } = extract(tmp);
		expect(nodes).toEqual([]);
	});

	it("returns empty for a missing/unreadable root (readdirSync catch)", () => {
		expect(extract(join(tmp, "does-not-exist"))).toEqual({ nodes: [], edges: [] });
	});
});
