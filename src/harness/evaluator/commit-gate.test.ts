import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FunctionComplexityEntry } from "../checks/cyclomatic.js";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import type { CoverageRunResult, CoverageRunner } from "../coverage-runner.js";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";
import {
	checkCommitGate,
	COMMIT_RUN_TIMEOUT_MS,
	type CommitGateDeps,
	defaultGitChangedFiles,
	defaultResolveRepoRoot,
	parseGitCommit,
} from "./commit-gate.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-commit-gate-"));
	mkdirSync(join(root, "src"), { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function rules(overrides?: Partial<NonNullable<GuardRulesConfig["per_edit_coverage"]>>): GuardRulesConfig {
	return {
		per_edit_coverage: {
			enabled: true,
			mode: "block",
			budget_ms: 25_000,
			languages: ["js", "ts"],
			...overrides,
		},
	} as unknown as GuardRulesConfig;
}

function commitEvent(command: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command },
		timestamp: "2026-06-07T00:00:00.000Z",
		cwd: root,
	};
}

/** Write a real source file to disk so `isCappableFile` + readFile see content. */
function writeSource(relPath: string, content: string): void {
	const abs = join(root, relPath);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content, "utf-8");
}

/** A GREEN coverage result with the given per-function rows for one file. */
function coverageResult(
	relPath: string,
	functions: PerFileCoverage["functions"],
	overrides: Partial<CoverageRunResult> = {},
): CoverageRunResult {
	const perFile = new Map<string, PerFileCoverage>();
	perFile.set(relPath, { filePath: relPath, mtime: 0, functions });
	return { suiteMs: 1000, perFile, ok: true, testsPassed: true, ...overrides };
}

/** A per-file coverage result carrying PER-LINE data (the coverage.py shape). */
function pyResult(relPath: string, covered: number[], uncovered: number[]): CoverageRunResult {
	const perFile = new Map<string, PerFileCoverage>();
	perFile.set(relPath, {
		filePath: relPath,
		mtime: 0,
		functions: [],
		coveredLines: new Set(covered),
		uncoveredLines: new Set(uncovered),
	});
	return { suiteMs: 1000, perFile, ok: true, testsPassed: true };
}

/** A stub runner that records whether/with-what-timeout it ran. */
function stubRunner(result: CoverageRunResult): {
	runner: CoverageRunner;
	ran: () => boolean;
	lastTimeout: () => number | undefined;
} {
	let called = false;
	let timeout: number | undefined;
	const runner: CoverageRunner = {
		run: async (opts) => {
			called = true;
			timeout = opts.timeoutMs;
			return result;
		},
	};
	return { runner, ran: () => called, lastTimeout: () => timeout };
}

/** Deps with a fixed runner, fixed changed-files list, and (optionally) a
 *  fixed cyclomatic analyzer. Default analyzer returns "no functions" so it can
 *  never block by accident; pass `entries` to drive CRAP / cyclomatic. */
function deps(
	runner: CoverageRunner,
	changed: string[] | null,
	entries: FunctionComplexityEntry[] | null = [],
): CommitGateDeps {
	return {
		runnerFor: () => runner,
		gitChangedFiles: () => changed,
		cyclomaticFor: () => () => entries,
		clock: () => 0,
		readFile: (abs: string): string | null => {
			try {
				return readFileSync(abs, "utf-8");
			} catch {
				return null;
			}
		},
	};
}

/** Build a per-function complexity entry from an options object (avoids a
 *  same-typed positional param clump the harness flags). */
function fn(opts: {
	name: string;
	line: number;
	endLine: number;
	cyclomatic: number;
	language?: FunctionComplexityEntry["language"];
}): FunctionComplexityEntry {
	return {
		name: opts.name,
		line: opts.line,
		endLine: opts.endLine,
		cyclomatic: opts.cyclomatic,
		language: opts.language ?? "js_ts",
	};
}

const JS_SRC = "export function f() {\n  return 1;\n}\n";

// ---------------------------------------------------------------------------
// parseGitCommit — re-export smoke test (full coverage lives in
// commit-parse.test.ts; this only proves the gate module re-exports it).
// ---------------------------------------------------------------------------

describe("parseGitCommit (re-export)", () => {
	it("detects a commit and flags --no-verify through the gate-module re-export", () => {
		expect(parseGitCommit('git commit -m "fix"')).toEqual({ isCommit: true, noVerify: false });
		expect(parseGitCommit("git commit -m x --no-verify")?.noVerify).toBe(true);
		expect(parseGitCommit("git status")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Parser → executor: the gate must evaluate the repo the commit actually runs
// in, honoring a `cd <dir>` / `git -C <dir>` redirect (finding 4). Without this,
// a monorepo `cd packages/x && git commit` gated the PARENT cwd — the wrong repo.
// ---------------------------------------------------------------------------

/** Deps that CAPTURE the projectRoot the gate hands to git-diff and the runner. */
function capturingRootDeps(coverage: CoverageRunResult): {
	deps: CommitGateDeps;
	gitRoot: () => string | undefined;
	suiteRoot: () => string | undefined;
} {
	let gitRoot: string | undefined;
	let suiteRoot: string | undefined;
	const deps: CommitGateDeps = {
		runnerFor: () => ({
			run: async (opts) => {
				suiteRoot = opts.projectRoot;
				return coverage;
			},
		}),
		gitChangedFiles: (projectRoot) => {
			gitRoot = projectRoot;
			return ["src/m.ts"]; // diff paths are relative to the (sub)repo root
		},
		cyclomaticFor: () => () => [],
		clock: () => 0,
		readFile: (abs) => {
			try {
				return readFileSync(abs, "utf-8");
			} catch {
				return null;
			}
		},
	};
	return { deps, gitRoot: () => gitRoot, suiteRoot: () => suiteRoot };
}

describe("checkCommitGate — honors a cd / git -C redirect (finding 4)", () => {
	it("runs git-diff AND the suite in the redirected subrepo, not the parent cwd", async () => {
		// A nested repo at packages/api with one changed source file on disk.
		writeSource("packages/api/src/m.ts", JS_SRC);
		const green = coverageResult("src/m.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 3, statement_pct: 100 },
		]);
		const { deps: capDeps, gitRoot, suiteRoot } = capturingRootDeps(green);
		// event.cwd is the PARENT (root); the command cd's into packages/api.
		const decision = await checkCommitGate(
			commitEvent("cd packages/api && git commit -m x"),
			rules(),
			capDeps,
		);
		const expected = join(root, "packages/api");
		expect(gitRoot()).toBe(expected);
		expect(suiteRoot()).toBe(expected);
		expect(decision).toBeNull(); // green subrepo → allow
	});

	it("equally honors `git -C <dir> commit`", async () => {
		writeSource("packages/api/src/m.ts", JS_SRC);
		const green = coverageResult("src/m.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 3, statement_pct: 100 },
		]);
		const { deps: capDeps, gitRoot } = capturingRootDeps(green);
		await checkCommitGate(commitEvent("git -C packages/api commit -m x"), rules(), capDeps);
		expect(gitRoot()).toBe(join(root, "packages/api"));
	});

	it("falls back to event.cwd when the command carries no redirect", async () => {
		writeSource("src/m.ts", JS_SRC);
		const green = coverageResult("src/m.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 3, statement_pct: 100 },
		]);
		const { deps: capDeps, gitRoot } = capturingRootDeps(green);
		await checkCommitGate(commitEvent("git commit -m x"), rules(), capDeps);
		expect(gitRoot()).toBe(root);
	});
});

// ---------------------------------------------------------------------------
// Staged-snapshot evaluation (finding 3): a plain commit must be judged against
// the INDEX (the would-be commit), not the dirty working tree. The materializer
// is stubbed here (its real git behavior is covered in staged-snapshot.test.ts);
// these tests pin the GATE's routing: which root the suite runs in per mode.
// ---------------------------------------------------------------------------

/** Deps that record the suite root + the `stagedOnly` flag, with an injectable
 *  index materializer (null ⇒ the worktree fallback). */
function capturingSuiteDeps(materialize: CommitGateDeps["materializeIndexSnapshot"]): {
	deps: CommitGateDeps;
	suiteRoot: () => string | undefined;
	stagedOnly: () => boolean | undefined;
} {
	let suiteRoot: string | undefined;
	let stagedOnly: boolean | undefined;
	const deps: CommitGateDeps = {
		runnerFor: () => ({
			run: async (opts) => {
				suiteRoot = opts.projectRoot;
				return coverageResult("src/m.ts", [
					{ name: "f", line: 1, endLine: 3, hits: 3, statement_pct: 100 },
				]);
			},
		}),
		gitChangedFiles: (_projectRoot, staged) => {
			stagedOnly = staged;
			return ["src/m.ts"];
		},
		cyclomaticFor: () => () => [],
		clock: () => 0,
		readFile: (abs) => {
			try {
				return readFileSync(abs, "utf-8");
			} catch {
				return null;
			}
		},
		...(materialize ? { materializeIndexSnapshot: materialize } : {}),
	};
	return { deps, suiteRoot: () => suiteRoot, stagedOnly: () => stagedOnly };
}

describe("checkCommitGate — staged-snapshot evaluation (finding 3)", () => {
	it("runs the suite in the materialized index snapshot for a plain commit", async () => {
		const snapRoot = join(root, ".interlinked", ".commit-snapshot-fixture");
		mkdirSync(join(snapRoot, "src"), { recursive: true });
		writeFileSync(join(snapRoot, "src/m.ts"), JS_SRC, "utf-8"); // staged content
		let cleaned = false;
		const { deps, suiteRoot, stagedOnly } = capturingSuiteDeps(() => ({
			root: snapRoot,
			cleanup: () => {
				cleaned = true;
			},
		}));
		const decision = await checkCommitGate(commitEvent("git commit -m x"), rules(), deps);
		expect(stagedOnly()).toBe(true); // plain commit → staged-only changed files
		expect(suiteRoot()).toBe(snapRoot); // evaluated the INDEX snapshot, not the worktree
		expect(cleaned).toBe(true); // snapshot cleaned up afterward
		expect(decision).toBeNull(); // green snapshot → allow
	});

	it("materializes the -a snapshot (index + tracked worktree, no untracked), not the raw worktree", async () => {
		writeSource("src/m.ts", JS_SRC);
		const snapRoot = join(root, ".interlinked", ".commit-snapshot-a");
		mkdirSync(join(snapRoot, "src"), { recursive: true });
		writeFileSync(join(snapRoot, "src/m.ts"), JS_SRC, "utf-8");
		let includeTracked: boolean | undefined;
		const { deps, suiteRoot, stagedOnly } = capturingSuiteDeps((_pr, inc) => {
			includeTracked = inc;
			return { root: snapRoot, cleanup: () => {} };
		});
		await checkCommitGate(commitEvent("git commit -am x"), rules(), deps);
		expect(stagedOnly()).toBe(false); // -a → working-tree tracked changed-files query
		expect(suiteRoot()).toBe(snapRoot); // the -a snapshot, NOT the raw worktree (no untracked)
		expect(includeTracked).toBe(true); // materialized WITH tracked worktree mods
	});

	it("falls back to the working tree when materialization fails (never worse than before)", async () => {
		writeSource("src/m.ts", JS_SRC);
		const { deps, suiteRoot } = capturingSuiteDeps(() => null); // materialization unavailable
		await checkCommitGate(commitEvent("git commit -m x"), rules(), deps);
		expect(suiteRoot()).toBe(root); // fell back to the worktree
	});
});

// ---------------------------------------------------------------------------
// checkCommitGate — gating / no-op
// ---------------------------------------------------------------------------

describe("checkCommitGate — gating", () => {
	it("is a pure no-op when per_edit_coverage is disabled (runner + git never called)", async () => {
		const { runner, ran } = stubRunner(coverageResult("src/a.ts", []));
		const gitDiff = vi.fn(() => ["src/a.ts"]);
		const decision = await checkCommitGate(commitEvent('git commit -m "x"'), rules({ enabled: false }), {
			runnerFor: () => runner,
			gitChangedFiles: gitDiff,
			cyclomaticFor: () => () => [],
			clock: () => 0,
			readFile: () => JS_SRC,
		});
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
		expect(gitDiff).not.toHaveBeenCalled();
	});

	it("is a no-op when per_edit_coverage config is entirely absent", async () => {
		const { runner, ran } = stubRunner(coverageResult("src/a.ts", []));
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			{} as GuardRulesConfig,
			deps(runner, ["src/a.ts"]),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
	});

	it("is a no-op for `git status` (not a commit; runner + git never called)", async () => {
		const { runner, ran } = stubRunner(coverageResult("src/a.ts", []));
		const gitDiff = vi.fn(() => ["src/a.ts"]);
		const decision = await checkCommitGate(commitEvent("git status"), rules(), {
			runnerFor: () => runner,
			gitChangedFiles: gitDiff,
			cyclomaticFor: () => () => [],
			clock: () => 0,
			readFile: () => JS_SRC,
		});
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
		expect(gitDiff).not.toHaveBeenCalled();
	});

	it("is a no-op for `git log` (not a commit)", async () => {
		const { runner, ran } = stubRunner(coverageResult("src/a.ts", []));
		const decision = await checkCommitGate(
			commitEvent("git log --oneline -n 5"),
			rules(),
			deps(runner, ["src/a.ts"]),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
	});

	it("allows (no-op) when only non-source files changed (tests / docs)", async () => {
		writeSource("src/a.test.ts", "it('x', () => {});\n");
		const { runner, ran } = stubRunner(coverageResult("src/a.ts", []));
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(runner, ["src/a.test.ts", "README.md"]),
		);
		expect(decision).toBeNull();
		// No gated source → the suite is never run.
		expect(ran()).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// checkCommitGate — block decisions
// ---------------------------------------------------------------------------

describe("checkCommitGate — block decisions", () => {
	it("BLOCKS when the full suite is RED, naming the failing test", async () => {
		writeSource("src/a.ts", JS_SRC);
		const result = coverageResult(
			"src/a.ts",
			[{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }],
			{ testsPassed: false, failingTests: ["adds two numbers", "handles empty"] },
		);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(stubRunner(result).runner, ["src/a.ts"]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/RED/);
		expect(decision?.reason).toMatch(/adds two numbers/);
		expect(decision?.rule_id).toBe("commit-gate");
	});

	it("BLOCKS when a changed file has an uncovered executable line (per-function), naming it", async () => {
		writeSource("src/a.ts", JS_SRC);
		const result = coverageResult("src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 0, statement_pct: 0 },
		]);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(stubRunner(result).runner, ["src/a.ts"]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/uncovered/i);
		expect(decision?.reason).toMatch(/`f`/);
	});

	it("BLOCKS when a changed function's CRAP is over threshold, naming it", async () => {
		writeSource("src/a.ts", JS_SRC);
		// cyclomatic 10 @ 20% coverage → CRAP ≈ 61 (≥30). Partially covered so the
		// uncovered-line check passes and CRAP is what fires.
		const result = coverageResult("src/a.ts", [
			{ name: "big", line: 1, endLine: 3, hits: 3, statement_pct: 20 },
		]);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(stubRunner(result).runner, ["src/a.ts"], [fn({ name: "big", line: 1, endLine: 3, cyclomatic: 10 })]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/CRAP score of 61/);
		expect(decision?.reason).toMatch(/`big`/);
	});

	it("BLOCKS when a changed function's cyclomatic is over the cap (>25)", async () => {
		writeSource("src/a.ts", JS_SRC);
		// Fully covered (coverage gate + CRAP pass) but cyclomatic 30 > 25 → block.
		const result = coverageResult("src/a.ts", [
			{ name: "branchy", line: 1, endLine: 3, hits: 9, statement_pct: 100 },
		]);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(stubRunner(result).runner, ["src/a.ts"], [fn({ name: "branchy", line: 1, endLine: 3, cyclomatic: 30 })]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/cyclomatic complexity 30/);
		expect(decision?.reason).toMatch(/`branchy`/);
	});

	it("RED bar wins over coverage / CRAP when both would fire", async () => {
		writeSource("src/a.ts", JS_SRC);
		const result = coverageResult(
			"src/a.ts",
			[{ name: "big", line: 1, endLine: 3, hits: 0, statement_pct: 0 }],
			{ testsPassed: false, failingTests: ["boom"] },
		);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(stubRunner(result).runner, ["src/a.ts"], [fn({ name: "big", line: 1, endLine: 3, cyclomatic: 30 })]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/RED/);
		expect(decision?.reason).not.toMatch(/CRAP/);
	});
});

// ---------------------------------------------------------------------------
// checkCommitGate — allow decisions
// ---------------------------------------------------------------------------

describe("checkCommitGate — allow decisions", () => {
	it("ALLOWS a clean tree: tests pass, covered, under CRAP + cyclomatic", async () => {
		writeSource("src/a.ts", JS_SRC);
		const result = coverageResult("src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 },
		]);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(stubRunner(result).runner, ["src/a.ts"], [fn({ name: "f", line: 1, endLine: 3, cyclomatic: 3 })]),
		);
		expect(decision).toBeNull();
	});

	it("runs the suite with the generous commit timeout (no per-edit cap)", async () => {
		writeSource("src/a.ts", JS_SRC);
		const result = coverageResult("src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 },
		]);
		const stub = stubRunner(result);
		await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(stub.runner, ["src/a.ts"], [fn({ name: "f", line: 1, endLine: 3, cyclomatic: 3 })]),
		);
		expect(stub.ran()).toBe(true);
		expect(stub.lastTimeout()).toBe(COMMIT_RUN_TIMEOUT_MS);
	});
});

// ---------------------------------------------------------------------------
// checkCommitGate — fail-open
// ---------------------------------------------------------------------------

describe("checkCommitGate — fail-open", () => {
	it("fail-open ALLOW (loud-degrade) when the runner is unavailable (ok:false)", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		writeSource("src/a.ts", JS_SRC);
		const failing: CoverageRunner = {
			run: async () => ({ suiteMs: 10, perFile: new Map(), ok: false, error: "boom", testsPassed: null }),
		};
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(failing, ["src/a.ts"], [fn({ name: "f", line: 1, endLine: 3, cyclomatic: 3 })]),
		);
		expect(decision).toBeNull();
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});

	it("fail-open ALLOW when the runner factory returns null (no runner for language)", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		writeSource("src/a.ts", JS_SRC);
		const decision = await checkCommitGate(commitEvent('git commit -m "x"'), rules(), {
			runnerFor: () => null,
			gitChangedFiles: () => ["src/a.ts"],
			cyclomaticFor: () => () => [],
			clock: () => 0,
			readFile: () => JS_SRC,
		});
		expect(decision).toBeNull();
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});

	it("fail-open ALLOW when git diff is unavailable (returns null)", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const { runner, ran } = stubRunner(coverageResult("src/a.ts", []));
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(runner, null),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});

	it("never throws — a throwing git-diff fn is contained (loud-degrade allow)", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const { runner } = stubRunner(coverageResult("src/a.ts", []));
		const throwingDeps: CommitGateDeps = {
			runnerFor: () => runner,
			gitChangedFiles: () => {
				throw new Error("git exploded");
			},
			cyclomaticFor: () => () => [],
			clock: () => 0,
			readFile: () => JS_SRC,
		};
		const decision = await checkCommitGate(commitEvent('git commit -m "x"'), rules(), throwingDeps);
		expect(decision).toBeNull();
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});

	it("CRAP / cyclomatic checks fail-open when the analyzer is unavailable (null), coverage still enforced", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		writeSource("src/a.ts", JS_SRC);
		// Covered function ⇒ coverage allows; analyzer null ⇒ no CRAP / cyclomatic block.
		const result = coverageResult("src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 },
		]);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(stubRunner(result).runner, ["src/a.ts"], null),
		);
		expect(decision).toBeNull();
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// checkCommitGate — --no-verify note
// ---------------------------------------------------------------------------

describe("checkCommitGate — --no-verify note", () => {
	it("warns that --no-verify bypasses git hooks while still allowing a clean tree", async () => {
		writeSource("src/a.ts", JS_SRC);
		const result = coverageResult("src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 },
		]);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x" --no-verify'),
			rules(),
			deps(stubRunner(result).runner, ["src/a.ts"], [fn({ name: "f", line: 1, endLine: 3, cyclomatic: 3 })]),
		);
		expect(decision?.decision).toBe("allow");
		expect(decision?.warnings?.some((w: string) => /--no-verify/.test(w))).toBe(true);
	});

	it("attaches the --no-verify note to a block decision too", async () => {
		writeSource("src/a.ts", JS_SRC);
		const result = coverageResult("src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 0, statement_pct: 0 },
		]);
		const decision = await checkCommitGate(
			commitEvent('git commit -am "x" --no-verify'),
			rules(),
			deps(stubRunner(result).runner, ["src/a.ts"]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.warnings?.some((w: string) => /--no-verify/.test(w))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// checkCommitGate — Python per-line path
// ---------------------------------------------------------------------------

describe("checkCommitGate — Python per-line path (coverage.py shape)", () => {
	const PY_SRC = "def added():\n    x = 1\n    y = 2\n    return x + y\n";

	it("BLOCKS when an added .py line is uncovered (missing_lines), naming the line", async () => {
		writeSource("src/a.py", PY_SRC);
		const result = pyResult("src/a.py", [1, 2, 4], [3]);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules({ languages: ["js", "ts", "python"] }),
			deps(stubRunner(result).runner, ["src/a.py"], [
				fn({ name: "added", line: 1, endLine: 4, cyclomatic: 1, language: "python" }),
			]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/line 3/);
		expect(decision?.reason).toMatch(/uncovered/i);
	});

	it("ALLOWS when every executable .py line is covered", async () => {
		writeSource("src/a.py", PY_SRC);
		const result = pyResult("src/a.py", [1, 2, 3, 4], []);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules({ languages: ["js", "ts", "python"] }),
			deps(stubRunner(result).runner, ["src/a.py"], [
				fn({ name: "added", line: 1, endLine: 4, cyclomatic: 2, language: "python" }),
			]),
		);
		expect(decision).toBeNull();
	});

	it("evaluates the WORKTREE for a constructed-content commit (`git add -A && git commit`)", async () => {
		// At PreToolUse the `git add -A` has NOT run, so the index is stale. The gate
		// must evaluate the worktree (the inclusive superset) — never the empty index
		// — so content the command will stage is not left unevaluated (finding 4).
		writeSource("src/m.ts", JS_SRC);
		let materializeCalled = false;
		const { deps, suiteRoot, stagedOnly } = capturingSuiteDeps(() => {
			materializeCalled = true;
			return { root: join(root, ".interlinked", ".snap"), cleanup: () => {} };
		});
		await checkCommitGate(commitEvent("git add -A && git commit -m x"), rules(), deps);
		expect(suiteRoot()).toBe(root); // the worktree, not a (stale-index) snapshot
		expect(materializeCalled).toBe(false); // worktree mode never materializes
		expect(stagedOnly()).toBe(false); // broad changed-files query, not staged-only
	});

	// ZERO-FALSE-POSITIVE CONTRACT (finding 6). A NARROW `git add <path> && git commit`
	// stages only that path; an unrelated dirty worktree file must NOT be evaluated
	// (the round-3 worktree-everything approach blocked on it).
	it("a narrow `git add <path> && git commit` evaluates ONLY that path, not unrelated dirty files", async () => {
		writeSource("src/a.ts", JS_SRC);
		writeSource("src/b.ts", JS_SRC); // unrelated dirty file — must be ignored
		const readPaths: string[] = [];
		const deps: CommitGateDeps = {
			runnerFor: () => ({
				run: async () =>
					coverageResult("src/a.ts", [{ name: "f", line: 1, endLine: 3, hits: 3, statement_pct: 100 }]),
			}),
			gitChangedFiles: () => ["src/a.ts", "src/b.ts"], // BOTH dirty in the worktree
			cyclomaticFor: () => () => [],
			clock: () => 0,
			readFile: (abs) => {
				readPaths.push(abs);
				try {
					return readFileSync(abs, "utf-8");
				} catch {
					return null;
				}
			},
		};
		await checkCommitGate(commitEvent("git add src/a.ts && git commit -m x"), rules(), deps);
		expect(readPaths.some((p) => p.endsWith("src/a.ts"))).toBe(true); // staged path evaluated
		expect(readPaths.some((p) => p.endsWith("src/b.ts"))).toBe(false); // unrelated file skipped
	});

	// MISSING-COVERAGE CONTRACT (finding 4). A changed source absent from the coverage
	// report after a full run was silently skipped — so a brand-new untested file passed.
	it("BLOCKS a changed source absent from the coverage report but with executable code", async () => {
		writeSource("src/new.ts", JS_SRC);
		const deps: CommitGateDeps = {
			runnerFor: () => ({
				// The report does NOT include src/new.ts — no test loaded it.
				run: async () => coverageResult("src/other.ts", []),
			}),
			gitChangedFiles: () => ["src/new.ts"],
			cyclomaticFor: () => () => [{ name: "f", line: 1, endLine: 3, cyclomatic: 2, language: "js_ts" }],
			clock: () => 0,
			readFile: (abs) => {
				try {
					return readFileSync(abs, "utf-8");
				} catch {
					return null;
				}
			},
		};
		const decision = await checkCommitGate(commitEvent("git commit -m x"), rules(), deps);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/untested|absent from the coverage report/i);
	});

	it("does NOT block a changed source absent from the report that has NO executable code (type-only)", async () => {
		writeSource("src/types.ts", "export interface T { a: number }\n");
		const deps: CommitGateDeps = {
			runnerFor: () => ({ run: async () => coverageResult("src/other.ts", []) }),
			gitChangedFiles: () => ["src/types.ts"],
			cyclomaticFor: () => () => [], // no functions → nothing to cover
			clock: () => 0,
			readFile: (abs) => {
				try {
					return readFileSync(abs, "utf-8");
				} catch {
					return null;
				}
			},
		};
		expect(await checkCommitGate(commitEvent("git commit -m x"), rules(), deps)).toBeNull();
	});

	// FUNCTION-LESS EXECUTABLE MODULES (finding 2026-06). The type-only exemption was
	// "the analyzer found no functions" — letting a module of top-level statements
	// (console.log, an initializing call) pass untested AND discharging its obligation.
	it("BLOCKS a function-less module with executable top-level statements absent from coverage", async () => {
		writeSource("src/boot.ts", 'console.log("side effect");\nstartServer();\n');
		const deps: CommitGateDeps = {
			runnerFor: () => ({ run: async () => coverageResult("src/other.ts", []) }),
			gitChangedFiles: () => ["src/boot.ts"],
			cyclomaticFor: () => () => [], // analyzer sees NO functions — the old exemption
			clock: () => 0,
			readFile: (abs) => {
				try {
					return readFileSync(abs, "utf-8");
				} catch {
					return null;
				}
			},
		};
		const decision = await checkCommitGate(commitEvent("git commit -m x"), rules(), deps);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/untested|absent from the coverage report/i);
	});
});

describe("checkCommitGate — changed-file query flags by mode (findings 2026-06)", () => {
	type QueryFlags = [boolean | undefined, boolean | undefined];

	function flagCapturingDeps(): { deps: CommitGateDeps; calls: () => QueryFlags[] } {
		const calls: QueryFlags[] = [];
		const deps: CommitGateDeps = {
			runnerFor: () => ({
				run: async () =>
					coverageResult("src/m.ts", [{ name: "f", line: 1, endLine: 3, hits: 3, statement_pct: 100 }]),
			}),
			gitChangedFiles: (_root, stagedOnly, includeUntracked) => {
				calls.push([stagedOnly, includeUntracked]);
				return ["src/m.ts"];
			},
			cyclomaticFor: () => () => [],
			clock: () => 0,
			readFile: (abs) => {
				try {
					return readFileSync(abs, "utf-8");
				} catch {
					return null;
				}
			},
		};
		return { deps, calls: () => calls };
	}

	it("a CONSTRUCTED commit (`git add … && git commit`) requests UNTRACKED files too", async () => {
		// The add stages new files at run time; `git diff` never lists them — without
		// includeUntracked a brand-new uncovered source bypassed the gate entirely.
		writeSource("src/m.ts", JS_SRC);
		const { deps, calls } = flagCapturingDeps();
		await checkCommitGate(commitEvent("git add -A && git commit -m x"), rules(), deps);
		expect(calls()).toEqual([[false, true]]); // broad query + untracked
	});

	it("`-a` requests tracked-only (NO untracked — `-a` never stages them)", async () => {
		writeSource("src/m.ts", JS_SRC);
		const { deps, calls } = flagCapturingDeps();
		await checkCommitGate(commitEvent("git commit -am x"), rules(), deps);
		expect(calls()).toEqual([[false, false]]);
	});

	it("a plain commit requests staged-only", async () => {
		writeSource("src/m.ts", JS_SRC);
		const { deps, calls } = flagCapturingDeps();
		await checkCommitGate(commitEvent("git commit -m x"), rules(), deps);
		expect(calls()).toEqual([[true, false]]);
	});

	it("anchors evaluation at the git TOPLEVEL when the commit runs from a subdirectory", async () => {
		// `cd src && git commit -a`: git emits toplevel-relative paths (src/a.ts), so
		// resolving them against /repo/src would double-prefix and skip every source.
		writeSource("src/m.ts", JS_SRC);
		mkdirSync(join(root, "sub"), { recursive: true });
		const rootsQueried: string[] = [];
		const deps: CommitGateDeps = {
			runnerFor: () => ({
				run: async () =>
					coverageResult("src/m.ts", [{ name: "f", line: 1, endLine: 3, hits: 3, statement_pct: 100 }]),
			}),
			gitChangedFiles: (queriedRoot) => {
				rootsQueried.push(queriedRoot);
				return ["src/m.ts"];
			},
			cyclomaticFor: () => () => [],
			clock: () => 0,
			readFile: (abs) => {
				try {
					return readFileSync(abs, "utf-8");
				} catch {
					return null;
				}
			},
			resolveRepoRoot: () => root, // the repo toplevel, NOT root/sub
		};
		await checkCommitGate(commitEvent("cd sub && git commit -am x"), rules(), deps);
		expect(rootsQueried).toEqual([root]); // anchored at the toplevel
	});
});

describe("defaultGitChangedFiles / defaultResolveRepoRoot — real git (findings 2026-06)", () => {
	let repo: string;

	function git(...args: string[]): void {
		execFileSync("git", args, { cwd: repo, stdio: "ignore" });
	}

	beforeEach(() => {
		repo = realpathSync(mkdtempSync(join(tmpdir(), "commit-gate-git-")));
		git("init", "-q");
		git("config", "user.email", "t@t.test");
		git("config", "user.name", "t");
		mkdirSync(join(repo, "src"), { recursive: true });
		writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n", "utf-8");
		git("add", "src/a.ts");
		git("commit", "-qm", "init");
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it("includeUntracked=true lists a brand-new file; false (the -a path) does not", () => {
		writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n", "utf-8"); // tracked mod
		writeFileSync(join(repo, "src/new.ts"), "export const n = 1;\n", "utf-8"); // untracked
		expect(defaultGitChangedFiles(repo, false, true)).toEqual(
			expect.arrayContaining(["src/a.ts", "src/new.ts"]),
		);
		expect(defaultGitChangedFiles(repo, false, false)).not.toContain("src/new.ts");
		expect(defaultGitChangedFiles(repo, true)).toEqual([]); // staged-only: nothing staged
	});

	it("resolves a subdirectory to the repository toplevel (and non-repos to null)", () => {
		expect(defaultResolveRepoRoot(join(repo, "src"))).toBe(repo);
		const notRepo = mkdtempSync(join(tmpdir(), "not-a-repo-"));
		try {
			expect(defaultResolveRepoRoot(notRepo)).toBeNull();
		} finally {
			rmSync(notRepo, { recursive: true, force: true });
		}
	});
});
