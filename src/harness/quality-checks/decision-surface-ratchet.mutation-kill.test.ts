import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// ===========================================
// Mutation-kill hardening for decision-surface-ratchet.ts
//
// The companion `decision-surface-ratchet.test.ts` exercises
// `diffDecisionSurface` thoroughly (pure) and the orchestrator's ref
// resolution at a coarse level, but never drives the git-backed
// `readFile`/`exists`/`readdir` closures built by (unexported)
// `makeGitBackedOptions`, never exercises the (unexported) default
// `execFileSync`-based `runGit`, and never distinguishes an entry that
// already existed at baseline from one that's genuinely new — a lockfile
// or config file present on BOTH sides is what proves the git-backed
// reader is working, since an entry missing from current shows the same
// "growth" result whether baseline correctly found it or not.
// ===========================================

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { computeDecisionSurfaceRatchet, diffDecisionSurface } from "./decision-surface-ratchet.js";
import type { DecisionSurfaceCategory } from "./decision-surface-map.js";
import type { DecisionSurfaceReport } from "./decision-surface.js";

const mockExecFileSync = vi.mocked(execFileSync);

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** Fresh, empty, uniquely-named temp dir — safe stand-in for a project
 *  root. `mkdtempSync`'s random suffix guarantees no cross-test/cross-agent
 *  collision even under a concurrent fleet. */
function makeTempCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "dsr-mutkill-"));
	tempDirs.push(dir);
	return dir;
}

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
// defaultRunGit — only reachable when no runGit override is supplied
// ===========================================

describe("defaultRunGit — exact execFileSync invocation (mocked child_process)", () => {
	// test-contract: invariant — with no runGit override, defaultRunGit must shell to the literal git binary via execFileSync with piped stdio (stderr never inherited) and UTF-8 decoding.
	it("invokes execFileSync with the git binary, exact args, and exact options", () => {
		const cwd = makeTempCwd();
		mockExecFileSync.mockReturnValue("");

		const result = computeDecisionSurfaceRatchet(cwd);

		expect(result.skipped).toBe("no-baseline-ref");
		expect(mockExecFileSync).toHaveBeenCalled();
		expect(mockExecFileSync.mock.calls[0]).toEqual([
			"git",
			["rev-parse", "--git-dir"],
			{
				cwd,
				encoding: "utf-8",
				timeout: 10_000,
				stdio: ["pipe", "pipe", "pipe"],
			},
		]);
	});
});

// ===========================================
// resolveBaselineRef — merge-base truthiness + exact git argv
// ===========================================

describe("resolveBaselineRef — merge-base truthiness and exact argv", () => {
	// test-contract: bug — a whitespace-only `git merge-base` stdout (a
	// stray newline, no real hash) must NOT be treated as "candidate
	// resolved"; only a trimmed, non-blank merge-base counts as a common
	// ancestor.
	it("treats a whitespace-only merge-base as no common ancestor (trim then check)", () => {
		const cwd = makeTempCwd();
		const result = computeDecisionSurfaceRatchet(cwd, {
			runGit: (args) => {
				if (args[0] === "rev-parse" && args[1] === "--git-dir") return ".git";
				if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "origin/main^{commit}") return "abc";
				if (args[0] === "merge-base" && args[1] === "HEAD" && args[2] === "origin/main") return "  \n\t ";
				throw new Error(`unmatched git call: ${args.join(" ")}`);
			},
		});

		expect(result.skipped).toBe("no-baseline-ref");
		expect(result.baselineRef).toBeNull();
	});

	// test-contract: bug — an EMPTY merge-base output must also make
	// resolveBaselineRef skip to the next candidate rather than treating the
	// empty string as "resolved". Also pins the exact argv passed to
	// `git merge-base`: HEAD is a literal, not a caller-supplied value.
	it("does not select a ref whose merge-base is empty, and calls git with exact ['merge-base','HEAD',ref]", () => {
		const cwd = makeTempCwd();
		const calls: string[][] = [];
		const result = computeDecisionSurfaceRatchet(cwd, {
			runGit: (args) => {
				calls.push([...args]);
				if (args[0] === "rev-parse" && args[1] === "--git-dir") return ".git";
				if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "origin/main^{commit}") return "abc";
				if (args[0] === "merge-base" && args[1] === "HEAD" && args[2] === "origin/main") return "";
				throw new Error(`unmatched git call: ${args.join(" ")}`);
			},
		});

		expect(result.skipped).toBe("no-baseline-ref");
		expect(result.baselineRef).toBeNull();
		const mergeBaseCall = calls.find((c) => c[0] === "merge-base");
		expect(mergeBaseCall).toEqual(["merge-base", "HEAD", "origin/main"]);
	});
});

// ===========================================
// CANDIDATE_BASE_REFS — bare 'main'/'master' fallback entries
// ===========================================

describe("CANDIDATE_BASE_REFS — bare 'main'/'master' fallback entries", () => {
	// test-contract: public-api — when neither origin/main nor origin/master
	// resolves (no configured remote, e.g. a fresh clone with no fetch yet),
	// the bare local branch name 'main' must still be tried before giving up.
	it("falls back to the bare 'main' ref when both origin refs are absent", () => {
		const cwd = makeTempCwd();
		const result = computeDecisionSurfaceRatchet(cwd, {
			runGit: (args) => {
				if (args[0] === "rev-parse" && args[1] === "--git-dir") return ".git";
				if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "main^{commit}") return "abc";
				if (args[0] === "merge-base" && args[1] === "HEAD" && args[2] === "main") return "deadbeef";
				throw new Error(`unmatched git call: ${args.join(" ")}`);
			},
		});

		expect(result.baselineRef).toBe("main");
		expect(result.skipped).toBeNull();
	});

	// test-contract: public-api — the final fallback candidate is the bare
	// 'master' branch name, tried only after origin/main, origin/master, and
	// bare 'main' have all failed to resolve.
	it("falls back to the bare 'master' ref when origin refs and bare 'main' are absent", () => {
		const cwd = makeTempCwd();
		const result = computeDecisionSurfaceRatchet(cwd, {
			runGit: (args) => {
				if (args[0] === "rev-parse" && args[1] === "--git-dir") return ".git";
				if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "master^{commit}") return "abc";
				if (args[0] === "merge-base" && args[1] === "HEAD" && args[2] === "master") return "deadbeef";
				throw new Error(`unmatched git call: ${args.join(" ")}`);
			},
		});

		expect(result.baselineRef).toBe("master");
		expect(result.skipped).toBeNull();
	});
});

// ===========================================
// buildWarnings — join separator (pure, via diffDecisionSurface)
// ===========================================

describe("buildWarnings — added-tools join separator", () => {
	// test-contract: public-api — the warning line lists multiple added
	// tools separated by ", " (comma-space); a bare concatenation would read
	// as one garbled tool name instead of a list.
	it("joins two added tools in the same category with a comma and space", () => {
		const baseline = makeReport({});
		const current = makeReport({ test_framework: ["alpha", "beta"] });
		const result = diffDecisionSurface(baseline, current, "origin/main");

		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("added alpha, beta.");
	});
});

// ===========================================
// makeGitBackedOptions — baseline signal detection
//
// Every fixture below places ONE entry on BOTH baseline (via the git stub)
// and current (via real fs) and a SECOND entry on current only. Only the
// overlap entry proves the git-backed reader correctly recognized
// pre-existing state (a broken reader silently drops it from baseline,
// which then wrongly reports it as new growth); the current-only entry
// proves new state is still detected. A baseline-only entry would prove
// nothing either way, since growth only ever reports current-not-in-
// baseline.
// ===========================================

describe("makeGitBackedOptions — baseline package.json/lockfile/config-file detection", () => {
	// test-contract: public-api — baseline package.json/lockfile/config-file signals must be read via the exact relative-path git command, and the diff must exclude entries present on both sides while surfacing current-only entries.
	it("reads baseline via exact git args and diffs correctly against real current-state fs", () => {
		const cwd = makeTempCwd();
		writeFileSync(
			join(cwd, "package.json"),
			JSON.stringify({ devDependencies: { jest: "1.0.0", vitest: "1.0.0" } }),
		);
		writeFileSync(join(cwd, "pnpm-lock.yaml"), "");
		writeFileSync(join(cwd, "yarn.lock"), "");
		writeFileSync(join(cwd, "biome.json"), "{}");
		writeFileSync(join(cwd, ".prettierrc"), "{}");

		const result = computeDecisionSurfaceRatchet(cwd, {
			runGit: (args) => {
				if (args[0] === "rev-parse" && args[1] === "--git-dir") return ".git";
				if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "origin/main^{commit}") return "abc";
				if (args[0] === "merge-base" && args[1] === "HEAD" && args[2] === "origin/main") return "deadbeef";
				if (args[0] === "show" && args[1] === "origin/main:package.json") {
					return JSON.stringify({ devDependencies: { jest: "1.0.0" } }); // baseline: jest only, no vitest
				}
				if (args[0] === "cat-file" && args[1] === "-e" && args[2] === "origin/main:pnpm-lock.yaml") return ""; // exists at baseline
				if (args[0] === "ls-tree" && args[1] === "--name-only" && args[2] === "origin/main") return "biome.json"; // no .prettierrc at baseline
				throw new Error(`unmatched git call: ${args.join(" ")}`);
			},
		});

		expect(result.skipped).toBeNull();
		expect(result.baselineRef).toBe("origin/main");
		expect(result.growthByCategory).toEqual({
			package_manager: ["yarn"],
			test_framework: ["vitest"],
			linter: [],
			formatter: ["prettier"],
			bundler: [],
			http_client: [],
			date_lib: [],
		});
		expect(result.totalGrowth).toBe(3);
	});

	// test-contract: bug — a failed git ls-tree at baseline must not propagate out of detectDecisionSurface; readdir's catch must return [] instead of letting the exception turn a git hiccup into a blanket "git-error" skip.
	it("does not propagate a git failure — the ratchet still completes normally with an empty baseline", () => {
		const cwd = makeTempCwd(); // empty dir: current-side report is all-empty too
		const result = computeDecisionSurfaceRatchet(cwd, {
			runGit: (args) => {
				if (args[0] === "rev-parse" && args[1] === "--git-dir") return ".git";
				if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "origin/main^{commit}") return "abc";
				if (args[0] === "merge-base" && args[1] === "HEAD" && args[2] === "origin/main") return "deadbeef";
				// show / cat-file / ls-tree all fall through to this throw,
				// simulating an unreadable baseline tree end to end.
				throw new Error("simulated git failure");
			},
		});

		expect(result.skipped).toBeNull();
		expect(result.baselineRef).toBe("origin/main");
		expect(result.totalGrowth).toBe(0);
		expect(result.warnings).toEqual([]);
	});
});
