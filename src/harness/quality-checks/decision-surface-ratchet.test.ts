import { describe, expect, it } from "vitest";
import type { DecisionSurfaceCategory } from "./decision-surface-map.js";
import type { DecisionSurfaceReport } from "./decision-surface.js";
import {
	computeDecisionSurfaceRatchet,
	diffDecisionSurface,
} from "./decision-surface-ratchet.js";

// ===========================================
// Fixture helpers
// ===========================================

function makeReport(byCategory: Partial<Record<DecisionSurfaceCategory, string[]>>): DecisionSurfaceReport {
	const filled: Record<DecisionSurfaceCategory, string[]> = {
		package_manager: byCategory.package_manager ?? [],
		test_framework: byCategory.test_framework ?? [],
		linter: byCategory.linter ?? [],
		formatter: byCategory.formatter ?? [],
		bundler: byCategory.bundler ?? [],
		http_client: byCategory.http_client ?? [],
		date_lib: byCategory.date_lib ?? [],
	};
	const total = Object.values(filled).reduce((sum, arr) => sum + arr.length, 0);
	return { byCategory: filled, totalSurface: total, projectRoot: "/repo" };
}

// ===========================================
// diffDecisionSurface — pure
// ===========================================

describe("diffDecisionSurface — pure diff semantics", () => {
	it("reports no growth when baseline equals current", () => {
		const baseline = makeReport({ test_framework: ["vitest"] });
		const current = makeReport({ test_framework: ["vitest"] });
		const result = diffDecisionSurface(baseline, current, "origin/main");
		expect(result.totalGrowth).toBe(0);
		expect(result.warnings).toEqual([]);
		expect(result.growthByCategory.test_framework).toEqual([]);
	});

	it("reports growth when a new test framework is added", () => {
		const baseline = makeReport({ test_framework: ["vitest"] });
		const current = makeReport({ test_framework: ["jest", "vitest"] });
		const result = diffDecisionSurface(baseline, current, "origin/main");
		expect(result.growthByCategory.test_framework).toEqual(["jest"]);
		expect(result.totalGrowth).toBe(1);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toMatch(/test_framework/);
		expect(result.warnings[0]).toMatch(/jest/);
		expect(result.warnings[0]).toMatch(/origin\/main/);
	});

	it("reports growth across multiple categories", () => {
		const baseline = makeReport({});
		const current = makeReport({
			test_framework: ["vitest"],
			linter: ["biome"],
			bundler: ["tsup"],
		});
		const result = diffDecisionSurface(baseline, current, "origin/main");
		expect(result.totalGrowth).toBe(3);
		expect(result.warnings).toHaveLength(3);
		expect(result.growthByCategory.test_framework).toEqual(["vitest"]);
		expect(result.growthByCategory.linter).toEqual(["biome"]);
		expect(result.growthByCategory.bundler).toEqual(["tsup"]);
	});

	it("is silent on shrinkage (tool removed)", () => {
		const baseline = makeReport({ test_framework: ["jest", "vitest"] });
		const current = makeReport({ test_framework: ["vitest"] });
		const result = diffDecisionSurface(baseline, current, "origin/main");
		expect(result.totalGrowth).toBe(0);
		expect(result.warnings).toEqual([]);
	});

	it("does NOT report a tool that exists in both (no churn)", () => {
		const baseline = makeReport({ test_framework: ["jest", "vitest"] });
		const current = makeReport({ test_framework: ["jest", "vitest"] });
		const result = diffDecisionSurface(baseline, current, "origin/main");
		expect(result.totalGrowth).toBe(0);
	});

	it("reports both growth and shrinkage as growth-only (substitution)", () => {
		// jest removed, mocha added — only mocha shows up as growth
		const baseline = makeReport({ test_framework: ["jest", "vitest"] });
		const current = makeReport({ test_framework: ["mocha", "vitest"] });
		const result = diffDecisionSurface(baseline, current, "origin/main");
		expect(result.growthByCategory.test_framework).toEqual(["mocha"]);
		expect(result.totalGrowth).toBe(1);
	});

	it("includes the baseline ref in each warning line", () => {
		const baseline = makeReport({});
		const current = makeReport({ http_client: ["axios"] });
		const result = diffDecisionSurface(baseline, current, "feature-branch-base");
		expect(result.warnings[0]).toMatch(/feature-branch-base/);
	});
});

// ===========================================
// computeDecisionSurfaceRatchet — orchestrator
// ===========================================

describe("computeDecisionSurfaceRatchet — git orchestration", () => {
	it("skips with reason 'not-a-repo' when git rev-parse fails", () => {
		const result = computeDecisionSurfaceRatchet("/repo", {
			runGit: () => {
				throw new Error("not a git repository");
			},
		});
		expect(result.skipped).toBe("not-a-repo");
		expect(result.baselineRef).toBeNull();
		expect(result.warnings).toEqual([]);
	});

	it("skips with reason 'no-baseline-ref' when no candidate ref resolves", () => {
		const result = computeDecisionSurfaceRatchet("/repo", {
			runGit: (args) => {
				if (args[0] === "rev-parse" && args[1] === "--git-dir") return ".git";
				throw new Error("unknown ref");
			},
		});
		expect(result.skipped).toBe("no-baseline-ref");
		expect(result.baselineRef).toBeNull();
		expect(result.warnings).toEqual([]);
	});

	it("uses the first candidate ref that resolves (origin/main preferred)", () => {
		const seenRefs: string[] = [];
		const result = computeDecisionSurfaceRatchet("/repo", {
			runGit: (args) => {
				if (args[0] === "rev-parse" && args[1] === "--git-dir") return ".git";
				if (args[0] === "rev-parse" && args[1] === "--verify") {
					const ref = (args[2] ?? "").replace(/\^\{commit\}$/, "");
					seenRefs.push(ref);
					if (ref === "origin/main") return "abcdef";
					throw new Error("unknown ref");
				}
				if (args[0] === "merge-base") return "abcdef";
				// Tree at origin/main looks empty (no package.json, no lockfiles, etc.)
				if (args[0] === "ls-tree") return "";
				if (args[0] === "show" || args[0] === "cat-file") throw new Error("not found");
				throw new Error(`unexpected: ${args.join(" ")}`);
			},
		});
		expect(seenRefs[0]).toBe("origin/main");
		expect(result.baselineRef).toBe("origin/main");
		expect(result.skipped).toBeNull();
	});

	it("falls back to origin/master when origin/main is absent", () => {
		const result = computeDecisionSurfaceRatchet("/repo", {
			runGit: (args) => {
				if (args[0] === "rev-parse" && args[1] === "--git-dir") return ".git";
				if (args[0] === "rev-parse" && args[1] === "--verify") {
					const ref = (args[2] ?? "").replace(/\^\{commit\}$/, "");
					if (ref === "origin/master") return "fedcba";
					throw new Error("unknown ref");
				}
				if (args[0] === "merge-base") return "fedcba";
				if (args[0] === "ls-tree") return "";
				if (args[0] === "show" || args[0] === "cat-file") throw new Error("not found");
				throw new Error(`unexpected: ${args.join(" ")}`);
			},
		});
		expect(result.baselineRef).toBe("origin/master");
	});

	it("orchestrator path does not throw on git output for unrelated git args", () => {
		// Smoke test: a minimal stub responds to everything; verify the
		// orchestrator doesn't throw and returns a sensible result.
		const result = computeDecisionSurfaceRatchet("/repo", {
			runGit: (args) => {
				if (args[0] === "rev-parse" && args[1] === "--git-dir") return ".git";
				if (args[0] === "rev-parse" && args[1] === "--verify") {
					if ((args[2] ?? "").startsWith("origin/main")) return "abcdef";
					throw new Error("unknown ref");
				}
				if (args[0] === "merge-base") return "abcdef";
				return ""; // ls-tree empty, show/cat-file shouldn't be called for empty tree
			},
		});
		expect(result.skipped).toBeNull();
		expect(result.totalGrowth).toBeGreaterThanOrEqual(0);
	});
});
