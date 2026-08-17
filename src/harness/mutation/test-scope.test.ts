// ===========================================
// test-scope — reverse-import-graph test selection for mutation runs
// ===========================================
// The measurement-integrity property under test: a hub file's mutation run
// must select the SAME complete test set the per-edit coverage gate would (via
// `selectAffectedTests`), capped rather than silently widened to "everything",
// and must fall back (return null) for anything the graph can't answer
// completely — never a partial/guessed set masquerading as complete.

import { describe, expect, it } from "vitest";
import type { BlastRadius, CallerSite, DependencyView } from "../dependency-view.js";
import { computeMutationTestScope, MAX_MUTATION_TEST_SCOPE } from "./test-scope.js";

const ROOT = "/repo";
const abs = (rel: string): string => `${ROOT}/${rel}`;

/** Same stub shape `coverage-test-selector.test.ts` uses: an explicit
 *  absolute-path edge map (file → its importers). */
function stubView(edges: Record<string, string[]>, known?: Set<string>): DependencyView {
	const membership = known ?? new Set<string>([...Object.keys(edges), ...Object.values(edges).flat()]);
	return {
		source: "internal",
		answerScope: "repo",
		getDependents: (file: string): string[] => edges[file] ?? [],
		hasFile: (file: string): boolean => membership.has(file),
		classifyModule: () => "internal",
		getBlastRadius: (): BlastRadius => ({ direct: 0, transitive: 0, domains: [] }),
		getCallers: (): CallerSite[] => [],
	};
}

function seedOnlyView(edges: Record<string, string[]>): DependencyView {
	return { ...stubView(edges), answerScope: "seed-only" };
}

describe("computeMutationTestScope — positive (must fire)", () => {
	it("P1: returns the graph-selected tests when the file is known and under the cap", () => {
		const view = stubView({ [abs("src/m.ts")]: [abs("src/m.test.ts")] });
		const result = computeMutationTestScope({ editedRelPath: "src/m.ts", projectRoot: ROOT, depView: view });
		expect(result).toEqual({ tests: ["src/m.test.ts"] });
	});

	it("P2: finds MULTIPLE sibling tests under different stems — the exact defect class this exists to fix", () => {
		// Mirrors the measured live case: session-state.ts has FOUR test files
		// that do not match its own filename stem at all.
		const view = stubView({
			[abs("src/session-state.ts")]: [abs("src/hub.ts")],
			[abs("src/hub.ts")]: [
				abs("src/__tests__/session-state.test.ts"),
				abs("src/__tests__/session-state-roundtrip.test.ts"),
				abs("src/__tests__/session-state-provenance.test.ts"),
				abs("src/__tests__/session-state-outcome.test.ts"),
				abs("src/__tests__/event-ordinal.test.ts"),
			],
		});
		const result = computeMutationTestScope({
			editedRelPath: "src/session-state.ts",
			projectRoot: ROOT,
			depView: view,
		});
		expect(result.tests).toHaveLength(5);
		expect(result.tests).toContain("src/__tests__/event-ordinal.test.ts");
		expect(result.tests).toContain("src/__tests__/session-state-roundtrip.test.ts");
	});

	it("P3b: a fixture helper living in a test directory is excluded from `tests` but real siblings still return — the runnable-entry filter", () => {
		// Measured live 2026-08-01: session-state.ts's graph scope includes
		// `src/harness/__tests__/sequence-fixtures.ts`, a zero-test fixture
		// factory that matches isTestSourcePath's directory rule but is not a
		// runnable vitest spec — forwarding it as-is broke the whole dry run.
		const view = stubView({
			[abs("src/m.ts")]: [
				abs("src/__tests__/m.test.ts"),
				abs("src/__tests__/fixtures.ts"),
			],
		});
		const result = computeMutationTestScope({ editedRelPath: "src/m.ts", projectRoot: ROOT, depView: view });
		expect(result.tests).toEqual(["src/__tests__/m.test.ts"]);
		expect(result.excludedNonRunnable).toEqual(["src/__tests__/fixtures.ts"]);
	});

	it("P3: a set exactly AT the cap is still returned (boundary — not falsely capped)", () => {
		const edges: Record<string, string[]> = {};
		const dependents: string[] = [];
		for (let i = 0; i < MAX_MUTATION_TEST_SCOPE; i++) dependents.push(abs(`src/__tests__/t${i}.test.ts`));
		edges[abs("src/m.ts")] = dependents;
		const view = stubView(edges);
		const result = computeMutationTestScope({ editedRelPath: "src/m.ts", projectRoot: ROOT, depView: view });
		expect(result.tests).toHaveLength(MAX_MUTATION_TEST_SCOPE);
		expect(result.reason).toBeUndefined();
	});
});

describe("computeMutationTestScope — negative (must not fire / must decline honestly)", () => {
	it("N1: an unknown file (not in the graph) returns null with reason unknown_file — caller falls back to filename globs", () => {
		const view = stubView({}, new Set());
		const result = computeMutationTestScope({ editedRelPath: "src/new.ts", projectRoot: ROOT, depView: view });
		expect(result.tests).toBeNull();
		expect(result.reason).toBe("unknown_file");
	});

	it("N2: a seed-only (Supermodel shard) view returns null with reason unknown_file — no honest transitive walk is possible", () => {
		const view = seedOnlyView({ [abs("src/m.ts")]: [abs("src/m.test.ts")] });
		const result = computeMutationTestScope({ editedRelPath: "src/m.ts", projectRoot: ROOT, depView: view });
		expect(result.tests).toBeNull();
		expect(result.reason).toBe("unknown_file");
	});

	it("N3: a known file with genuinely zero affected tests returns null with reason no_affected_tests — never an empty array a caller might misread as 'skip the runner check'", () => {
		const view = stubView({ [abs("src/leaf.ts")]: [] });
		const result = computeMutationTestScope({ editedRelPath: "src/leaf.ts", projectRoot: ROOT, depView: view });
		expect(result.tests).toBeNull();
		expect(result.reason).toBe("no_affected_tests");
	});

	it("N3b: a scope that resolves to ONLY non-runnable fixtures returns null with reason no_affected_tests, and reports them in excludedNonRunnable", () => {
		const view = stubView({
			[abs("src/m.ts")]: [abs("src/__tests__/fixtures.ts")],
		});
		const result = computeMutationTestScope({ editedRelPath: "src/m.ts", projectRoot: ROOT, depView: view });
		expect(result.tests).toBeNull();
		expect(result.reason).toBe("no_affected_tests");
		expect(result.excludedNonRunnable).toEqual(["src/__tests__/fixtures.ts"]);
	});

	it("N4: over-cap is reported, not silently truncated — the real count survives on the result for the caller to log", () => {
		const edges: Record<string, string[]> = {};
		const dependents: string[] = [];
		for (let i = 0; i < MAX_MUTATION_TEST_SCOPE + 1; i++) dependents.push(abs(`src/__tests__/t${i}.test.ts`));
		edges[abs("src/hub.ts")] = dependents;
		const view = stubView(edges);
		const result = computeMutationTestScope({ editedRelPath: "src/hub.ts", projectRoot: ROOT, depView: view });
		expect(result.tests).toBeNull();
		expect(result.reason).toBe("over_cap");
		expect(result.uncappedCount).toBe(MAX_MUTATION_TEST_SCOPE + 1);
	});
});

describe("computeMutationTestScope — over-cap companion fallback", () => {
	// The trajectory.ts defect (bug #2): its reverse-import graph resolved 158
	// tests, over MAX_MUTATION_TEST_SCOPE, so the scope declined to nothing — the
	// runner then fell back to its four-stem filename glob and NEVER ran
	// trajectory.mutation-kill.test.ts, so every mutant only that kill test would
	// catch reported as a false survivor. An over-cap decline must STILL ship the
	// target's own companion kill tests.

	/** An over-cap hub of unrelated (but co-located, under `__tests__/`) tests,
	 *  plus whatever companion candidates the case wants to add. */
	function overCapView(extraDependents: string[]): DependencyView {
		const dependents: string[] = [];
		for (let i = 0; i <= MAX_MUTATION_TEST_SCOPE; i++) {
			dependents.push(abs(`src/harness/__tests__/unrelated-${i}.test.ts`));
		}
		return stubView({ [abs("src/harness/trajectory.ts")]: [...dependents, ...extraDependents] });
	}

	function scopeForTrajectory(view: DependencyView) {
		return computeMutationTestScope({ editedRelPath: "src/harness/trajectory.ts", projectRoot: ROOT, depView: view });
	}

	it("P1: over cap still ships the target's own companion + mutation-kill tests, while `tests` stays null", () => {
		const result = scopeForTrajectory(
			overCapView([abs("src/harness/trajectory.test.ts"), abs("src/harness/trajectory.mutation-kill.test.ts")]),
		);
		// The full (over-cap) set is still DECLINED — provenance must never read as
		// a complete import-graph run.
		expect(result.tests).toBeNull();
		expect(result.reason).toBe("over_cap");
		// …but the companion kill tests ship instead of the runner's lossy stem glob.
		expect(result.companionScope).toContain("src/harness/trajectory.test.ts");
		expect(result.companionScope).toContain("src/harness/trajectory.mutation-kill.test.ts");
		// ONLY the target's own companions — never the 151-strong hub of co-located
		// but unrelated tests (that would just re-approach the cap it declined).
		expect(result.companionScope).toHaveLength(2);
	});

	it("P2: an umbrella companion under __tests__/ resolves to the SUT's directory", () => {
		const result = scopeForTrajectory(overCapView([abs("src/harness/__tests__/trajectory.test.ts")]));
		expect(result.reason).toBe("over_cap");
		expect(result.companionScope).toEqual(["src/harness/__tests__/trajectory.test.ts"]);
	});

	it("P3: a co-located *.survivors.test.ts importing the SUT ships under a NON-base name — the survivor clause", () => {
		const result = scopeForTrajectory(overCapView([abs("src/harness/legacy.survivors.test.ts")]));
		expect(result.reason).toBe("over_cap");
		expect(result.companionScope).toEqual(["src/harness/legacy.survivors.test.ts"]);
	});

	it("N1: an over-cap file with NO co-located companion omits companionScope (the runner glob still applies)", () => {
		const result = scopeForTrajectory(overCapView([]));
		expect(result.reason).toBe("over_cap");
		expect(result.companionScope).toBeUndefined();
	});

	it("N2: a same-named test in a DIFFERENT directory is not a companion (co-location is required)", () => {
		// `src/other/trajectory.test.ts` shares the base name but not the directory —
		// it is some other tree's file, not this target's companion.
		const result = scopeForTrajectory(overCapView([abs("src/other/trajectory.test.ts")]));
		expect(result.reason).toBe("over_cap");
		expect(result.companionScope).toBeUndefined();
	});
});
