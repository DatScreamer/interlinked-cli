// ===========================================
// coverage-test-selector — affected-test selection over the reverse import graph
// ===========================================
// The keystone of affordable per-edit coverage: given an edited file, BFS the
// reverse import graph (DependencyView.getDependents) transitively and return
// ONLY the test files that could be affected. Tri-state contract:
//   - transitive test dependents (deduped, sorted) when the file is in the graph;
//   - `null` when the file is NOT in the graph (caller → full suite);
//   - `[]` when the file IS in the graph but no test depends on it (caller →
//     strict-TDD block).
// The view is stubbed (no real ProjectGraph); a temp dir backs the companion-
// test existence check.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BlastRadius, CallerSite, DependencyView } from "../dependency-view.js";
import { isTestPath, selectAffectedTests } from "../coverage-test-selector.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cov-selector-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/**
 * A stub DependencyView whose reverse graph is an explicit absolute-path edge map
 * (`file → its importers`) and whose membership set is the union of every node
 * mentioned. `getDependents` reads the map; `hasFile` reads the membership set —
 * letting a test model "known leaf with no dependents" (in the set, empty edges)
 * distinctly from "unknown file" (absent from the set).
 */
function stubView(edges: Record<string, string[]>, known?: Set<string>): DependencyView {
	const membership = known ?? new Set<string>([...Object.keys(edges), ...Object.values(edges).flat()]);
	return {
		source: "internal",
		getDependents: (file: string): string[] => edges[file] ?? [],
		hasFile: (file: string): boolean => membership.has(file),
		classifyModule: () => "internal",
		getBlastRadius: (): BlastRadius => ({ direct: 0, transitive: 0, domains: [] }),
		getCallers: (): CallerSite[] => [],
	};
}

/** Absolute path under the temp root for a repo-relative POSIX path. */
function abs(rel: string): string {
	return resolve(root, rel);
}

// ---------------------------------------------------------------------------
// Positive cases — transitive selection
// ---------------------------------------------------------------------------

describe("selectAffectedTests — positive (test dependents found)", () => {
	it("selects BOTH a direct companion test and an integration test that import the file", () => {
		// m.ts ← m.test.ts AND ← integration.test.ts (both direct importers).
		const view = stubView({
			[abs("src/m.ts")]: [abs("src/m.test.ts"), abs("tests/integration.test.ts")],
		});
		const selected = selectAffectedTests({ editedRelPath: "src/m.ts", projectRoot: root, depView: view });
		expect(selected).toEqual(["src/m.test.ts", "tests/integration.test.ts"]);
	});

	it("selects a TRANSITIVE test (test imports a module that imports the edited file)", () => {
		// m.ts ← helper.ts ← helper.test.ts. helper.ts is not a test, but the BFS
		// keeps walking and collects helper.test.ts two hops out.
		const view = stubView({
			[abs("src/m.ts")]: [abs("src/helper.ts")],
			[abs("src/helper.ts")]: [abs("src/helper.test.ts")],
		});
		const selected = selectAffectedTests({ editedRelPath: "src/m.ts", projectRoot: root, depView: view });
		expect(selected).toEqual(["src/helper.test.ts"]);
	});

	it("dedupes a test reachable via multiple paths and sorts the result", () => {
		// big.test.ts imports both a.ts and b.ts, which both import m.ts → it is
		// reachable twice but appears once; z.test.ts sorts after big.test.ts.
		const view = stubView({
			[abs("src/m.ts")]: [abs("src/a.ts"), abs("src/b.ts"), abs("src/z.test.ts")],
			[abs("src/a.ts")]: [abs("src/big.test.ts")],
			[abs("src/b.ts")]: [abs("src/big.test.ts")],
		});
		const selected = selectAffectedTests({ editedRelPath: "src/m.ts", projectRoot: root, depView: view });
		expect(selected).toEqual(["src/big.test.ts", "src/z.test.ts"]);
	});

	it("includes the edited file's on-disk companion test even if the graph missed it", () => {
		// The graph reports NO dependents, but src/m.test.ts exists on disk → it is
		// added as a companion. (File in the graph, so not null.)
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src/m.test.ts"), "it('x', () => {});\n", "utf-8");
		const view = stubView({ [abs("src/m.ts")]: [] });
		const selected = selectAffectedTests({ editedRelPath: "src/m.ts", projectRoot: root, depView: view });
		expect(selected).toEqual(["src/m.test.ts"]);
	});

	it("finds a Python companion (test_*.py) and a *_test.go dependent", () => {
		const view = stubView({
			[abs("src/m.py")]: [abs("tests/test_m.py"), abs("src/m_helper.py")],
			[abs("src/m_helper.py")]: [abs("pkg/m_test.go")],
		});
		const selected = selectAffectedTests({ editedRelPath: "src/m.py", projectRoot: root, depView: view });
		expect(selected).toEqual(["pkg/m_test.go", "tests/test_m.py"]);
	});
});

// ---------------------------------------------------------------------------
// Negative cases — null / [] / non-test filtering
// ---------------------------------------------------------------------------

describe("selectAffectedTests — negative (null / empty / filtering)", () => {
	it("returns null when the edited file is NOT in the graph", () => {
		// Membership set excludes the edited file → null → caller runs full suite.
		const view = stubView({}, new Set<string>([abs("src/other.ts")]));
		const selected = selectAffectedTests({ editedRelPath: "src/m.ts", projectRoot: root, depView: view });
		expect(selected).toBeNull();
	});

	it("returns [] when the file is in the graph but NO test depends on it", () => {
		// m.ts is imported by a non-test (app.ts) only, and has no companion on disk.
		const view = stubView({
			[abs("src/m.ts")]: [abs("src/app.ts")],
			[abs("src/app.ts")]: [abs("src/main.ts")],
		});
		const selected = selectAffectedTests({ editedRelPath: "src/m.ts", projectRoot: root, depView: view });
		expect(selected).toEqual([]);
	});

	it("returns [] for a known leaf with zero dependents and no companion", () => {
		const view = stubView({ [abs("src/leaf.ts")]: [] });
		const selected = selectAffectedTests({ editedRelPath: "src/leaf.ts", projectRoot: root, depView: view });
		expect(selected).toEqual([]);
	});

	it("does NOT include non-test dependents (only real test files survive the filter)", () => {
		const view = stubView({
			[abs("src/m.ts")]: [abs("src/consumer.ts"), abs("src/m.test.ts")],
		});
		const selected = selectAffectedTests({ editedRelPath: "src/m.ts", projectRoot: root, depView: view });
		expect(selected).toEqual(["src/m.test.ts"]);
		expect(selected).not.toContain("src/consumer.ts");
	});

	it("drops a dependent that resolves OUTSIDE the project root", () => {
		// A foreign-repo importer (../other-repo/x.test.ts) is not part of this
		// repo's test run, so it is excluded; the in-tree test remains.
		const view = stubView({
			[abs("src/m.ts")]: [abs("src/m.test.ts"), join(root, "..", "other-repo", "x.test.ts")],
		});
		const selected = selectAffectedTests({ editedRelPath: "src/m.ts", projectRoot: root, depView: view });
		expect(selected).toEqual(["src/m.test.ts"]);
	});

	it("terminates on a cyclic reverse graph (a ↔ b) without hanging", () => {
		// m.ts ← a.ts ← b.ts ← a.ts (cycle). The visited set bounds the walk; the
		// one test (a.test.ts) is found exactly once.
		const view = stubView({
			[abs("src/m.ts")]: [abs("src/a.ts")],
			[abs("src/a.ts")]: [abs("src/b.ts"), abs("src/a.test.ts")],
			[abs("src/b.ts")]: [abs("src/a.ts")],
		});
		const selected = selectAffectedTests({ editedRelPath: "src/m.ts", projectRoot: root, depView: view });
		expect(selected).toEqual(["src/a.test.ts"]);
	});
});

// ---------------------------------------------------------------------------
// isTestPath — the cross-language predicate
// ---------------------------------------------------------------------------

describe("isTestPath", () => {
	it("matches the pinned test-file conventions", () => {
		expect(isTestPath("src/m.test.ts")).toBe(true);
		expect(isTestPath("src/m.spec.tsx")).toBe(true);
		expect(isTestPath("src/__tests__/m.ts")).toBe(true);
		expect(isTestPath("tests/test_m.py")).toBe(true);
		expect(isTestPath("src/m_test.py")).toBe(true);
		expect(isTestPath("pkg/m_test.go")).toBe(true);
	});

	it("does not match plain source files", () => {
		expect(isTestPath("src/m.ts")).toBe(false);
		expect(isTestPath("src/testimony.ts")).toBe(false); // 'test' substring, not a test file
		expect(isTestPath("src/contest.py")).toBe(false);
		expect(isTestPath("src/latest.go")).toBe(false);
	});
});
