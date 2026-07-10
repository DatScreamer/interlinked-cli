// Tests for the test-oracle diff checks. Everything drives the injectable
// OracleDiffDeps seam — no live git, no disk.

import { describe, expect, it } from "vitest";
import {
	checkAssertionCountRegression,
	checkAssertionValueSwap,
	checkTestBlockCountRegression,
	classifyTestBlockLoss,
	companionSourceCandidates,
	type OracleDiffDeps,
} from "./behavioral-diff-checks-oracle.js";
import type { SessionTrajectory } from "./types.js";

function session(files: string[]): SessionTrajectory {
	return { files_written: files } as unknown as SessionTrajectory;
}

function deps(
	diffs: Record<string, string>,
	existing: string[] = ["everything"],
): OracleDiffDeps {
	return {
		stagedDiff: (f) => diffs[f] ?? "",
		sourceExists: (p) => existing.includes("everything") || existing.includes(p),
	};
}

const DEL_TWO_TESTS = [
	"--- a/src/foo.test.ts",
	"+++ b/src/foo.test.ts",
	"-it('a', () => { expect(f(1)).toBe(2); });",
	"-it('b', () => { expect(f(2)).toBe(3); });",
].join("\n");

describe("checkTestBlockCountRegression — SUT-conditioned", () => {
	it("ERROR on unexplained loss: SUT alive, commit net negative, no .each", () => {
		const s = session(["/r/src/foo.test.ts"]);
		const out = checkTestBlockCountRegression(s, deps({ "/r/src/foo.test.ts": DEL_TWO_TESTS }));
		expect(out).toHaveLength(1);
		expect(out[0]?.severity).toBe("error");
		expect(out[0]?.message).toContain("removed 2 more test block(s)");
	});

	it("INFO cascade when the companion SUT no longer exists", () => {
		const s = session(["/r/src/foo.test.ts"]);
		const out = checkTestBlockCountRegression(
			s,
			deps({ "/r/src/foo.test.ts": DEL_TWO_TESTS }, []),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.severity).toBe("info");
		expect(out[0]?.message).toContain("deletion cascade");
	});

	it("INFO move when sibling test files gain at least as much", () => {
		const gain = [
			"+it('a', () => { expect(g(1)).toBe(2); });",
			"+it('b', () => { expect(g(2)).toBe(3); });",
			"+it('c', () => { expect(g(3)).toBe(4); });",
		].join("\n");
		const s = session(["/r/src/foo.test.ts", "/r/src/bar.test.ts"]);
		const out = checkTestBlockCountRegression(
			s,
			deps({ "/r/src/foo.test.ts": DEL_TWO_TESTS, "/r/src/bar.test.ts": gain }),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.severity).toBe("info");
		expect(out[0]?.message).toContain("move");
	});

	it("INFO consolidation when an it.each table is introduced in the same diff", () => {
		const consolidated = `${DEL_TWO_TESTS}\n+it.each([[1,2],[2,3]])('f(%i)', (a, b) => { expect(f(a)).toBe(b); });`;
		const s = session(["/r/src/foo.test.ts"]);
		const out = checkTestBlockCountRegression(
			s,
			deps({ "/r/src/foo.test.ts": consolidated }),
		);
		// net is -2 +1 = -1 → still a loss, but explained by the .each table.
		expect(out).toHaveLength(1);
		expect(out[0]?.severity).toBe("info");
		expect(out[0]?.message).toContain("consolidation");
	});

	it("silent when nothing was lost", () => {
		const s = session(["/r/src/foo.test.ts"]);
		const add = "+it('new', () => { expect(1).toBe(1); });";
		expect(checkTestBlockCountRegression(s, deps({ "/r/src/foo.test.ts": add }))).toEqual([]);
	});

	it("classifyTestBlockLoss is exported for the history replay", () => {
		const d = { file: "/r/x.test.ts", plus: 0, minus: 1, net: -1, addedEachTable: false };
		expect(classifyTestBlockLoss(d, -1, deps({}, []))).toBe("cascade");
		expect(classifyTestBlockLoss(d, 0, deps({}))).toBe("move");
		expect(classifyTestBlockLoss({ ...d, addedEachTable: true }, -1, deps({}))).toBe(
			"each_table",
		);
		expect(classifyTestBlockLoss(d, -1, deps({}))).toBe("unexplained");
	});

	it("INFO sut_shrank when the companion source also net-shrank (removed behavior)", () => {
		// Replay case 496834f: a dropped false-positive signal took -73 source
		// lines and its 6 tests together — the companion's diff is net-negative.
		const d = { file: "/r/src/x.test.ts", plus: 0, minus: 6, net: -6, addedEachTable: false };
		const sutShrinking = deps(
			{ "/r/src/x.ts": "-gone1\n-gone2\n-gone3\n+kept" },
			["/r/src/x.ts"],
		);
		expect(classifyTestBlockLoss(d, -6, sutShrinking)).toBe("sut_shrank");
		// A companion that GREW does not explain deleted tests.
		const sutGrowing = deps({ "/r/src/x.ts": "+new1\n+new2" }, ["/r/src/x.ts"]);
		expect(classifyTestBlockLoss(d, -6, sutGrowing)).toBe("unexplained");
	});

	it("INFO declared_test_maintenance on a test:-typed commit (replay case faeb551)", () => {
		const d = { file: "/r/src/x.test.ts", plus: 0, minus: 1, net: -1, addedEachTable: false };
		const unchanged = deps({ "/r/src/x.ts": "" }, ["/r/src/x.ts"]);
		expect(classifyTestBlockLoss(d, -1, unchanged, "test")).toBe("declared_test_maintenance");
		expect(classifyTestBlockLoss(d, -1, unchanged, "fix")).toBe("unexplained");
	});
});

describe("companionSourceCandidates", () => {
	it("maps sibling and __tests__ conventions across JS/TS extensions", () => {
		const sibling = companionSourceCandidates("/r/src/foo.test.ts");
		expect(sibling).toContain("/r/src/foo.ts");
		expect(sibling).toContain("/r/src/foo.tsx");
		const dunder = companionSourceCandidates("/r/src/__tests__/foo.test.ts");
		expect(dunder).toContain("/r/src/foo.ts");
	});
});

describe("checkAssertionCountRegression", () => {
	it("warns when test assertions net-drop while source changed", () => {
		const s = session(["/r/src/foo.test.ts", "/r/src/foo.ts"]);
		const out = checkAssertionCountRegression(
			s,
			deps({
				"/r/src/foo.test.ts": "-  expect(f(1)).toBe(2);\n-  expect(f(2)).toBe(3);",
				"/r/src/foo.ts": "+export const x = 1;",
			}),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.severity).toBe("warning");
		expect(out[0]?.message).toContain("net-removed 2 assertion(s)");
	});

	it("silent when assertions grew, or only tests changed", () => {
		const s = session(["/r/src/foo.test.ts", "/r/src/foo.ts"]);
		expect(
			checkAssertionCountRegression(
				s,
				deps({
					"/r/src/foo.test.ts": "+  expect(f(1)).toBe(2);",
					"/r/src/foo.ts": "+export const x = 1;",
				}),
			),
		).toEqual([]);
		const testsOnly = session(["/r/src/foo.test.ts"]);
		expect(
			checkAssertionCountRegression(
				testsOnly,
				deps({ "/r/src/foo.test.ts": "-  expect(f(1)).toBe(2);" }),
			),
		).toEqual([]);
	});
});

describe("checkAssertionValueSwap", () => {
	it("flags same subject + matcher with a changed expected value (info)", () => {
		const s = session(["/r/src/foo.test.ts"]);
		const diff = ["-  expect(total(order)).toBe(5);", "+  expect(total(order)).toBe(6);"].join(
			"\n",
		);
		const out = checkAssertionValueSwap(s, deps({ "/r/src/foo.test.ts": diff }));
		expect(out).toHaveLength(1);
		expect(out[0]?.severity).toBe("info");
		expect(out[0]?.message).toContain("5");
		expect(out[0]?.message).toContain("6");
	});

	it("silent on unrelated add/remove pairs and non-value edits", () => {
		const s = session(["/r/src/foo.test.ts"]);
		const differentSubject = ["-  expect(a(x)).toBe(1);", "+  expect(b(x)).toBe(1);"].join("\n");
		expect(checkAssertionValueSwap(s, deps({ "/r/src/foo.test.ts": differentSubject }))).toEqual(
			[],
		);
		const sameValue = ["-  expect(a(x)).toBe(1);", "+  expect(a(x)).toBe(1);"].join("\n");
		expect(checkAssertionValueSwap(s, deps({ "/r/src/foo.test.ts": sameValue }))).toEqual([]);
	});

	it("caps at 3 findings per file", () => {
		const lines: string[] = [];
		for (let i = 0; i < 6; i++) {
			lines.push(`-  expect(f${i}(x)).toBe(${i});`, `+  expect(f${i}(x)).toBe(${i + 1});`);
		}
		const s = session(["/r/src/foo.test.ts"]);
		const out = checkAssertionValueSwap(s, deps({ "/r/src/foo.test.ts": lines.join("\n") }));
		expect(out).toHaveLength(3);
	});
});
