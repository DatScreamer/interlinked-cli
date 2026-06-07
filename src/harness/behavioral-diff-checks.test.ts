import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkAssertionStrengthWeakening,
	checkClockMockAdded,
	checkConventionalCommitCoherence,
	checkDisabledTestDelta,
	checkDoneWithoutVerify,
	checkReintroducesRemovedCode,
	checkTestBlockCountRegression,
	parseCommitMessageFromBash,
} from "./behavioral-diff-checks.js";
import type { SessionTrajectory } from "./types.js";

// ==========================================================================
// parseCommitMessageFromBash — pure-function unit tests
// ==========================================================================

describe("parseCommitMessageFromBash", () => {
	it("parses double-quoted -m \"fix: foo\"", () => {
		expect(parseCommitMessageFromBash(`git commit -m "fix: foo bar"`)).toEqual({
			type: "fix",
			subject: "foo bar",
		});
	});

	it("parses single-quoted -m 'feat: x'", () => {
		expect(parseCommitMessageFromBash(`git commit -m 'feat: x'`)).toEqual({
			type: "feat",
			subject: "x",
		});
	});

	it("parses scope and breaking-change marker", () => {
		expect(parseCommitMessageFromBash(`git commit -m "fix(auth)!: blah"`)).toEqual({
			type: "fix",
			subject: "blah",
		});
	});

	it("returns null when no -m flag", () => {
		expect(parseCommitMessageFromBash(`git commit`)).toBeNull();
	});

	it("returns null when message has no conventional prefix", () => {
		expect(parseCommitMessageFromBash(`git commit -m "plain message"`)).toBeNull();
	});

	it("lowercases the type", () => {
		expect(parseCommitMessageFromBash(`git commit -m "Fix: caps"`)?.type).toBe("fix");
	});
});

// ==========================================================================
// Diff-aware checks — exercised against a real temp git repo
// ==========================================================================

let repoDir: string;

function git(args: string[]): string {
	return execSync(`git ${args.join(" ")}`, { cwd: repoDir, encoding: "utf-8" });
}

function setupRepo(): void {
	repoDir = mkdtempSync(join(tmpdir(), "diff-checks-"));
	git(["init", "-q"]);
	git(["config", "user.email", "test@example.com"]);
	git(["config", "user.name", "Test"]);
	git(["config", "commit.gpgsign", "false"]);
}

beforeEach(() => {
	setupRepo();
});

afterEach(() => {
	try {
		execSync(`rm -rf ${repoDir}`);
	} catch {
		// Best-effort cleanup; on Windows mkdtempSync uses %TMP% but this
		// suite runs in CI on linux/mac.
	}
});

function commitInitial(file: string, content: string): void {
	writeFileSync(join(repoDir, file), content);
	git(["add", "."]);
	git(["commit", "-q", "-m", "initial"]);
}

function stageEdit(file: string, content: string): void {
	writeFileSync(join(repoDir, file), content);
	git(["add", "."]);
}

function makeSession(files: string[]): SessionTrajectory {
	return {
		files_written: new Set(files.map((f) => join(repoDir, f))),
		files_read: new Set(),
		file_edit_counts: new Map(),
		test_runs: new Map(),
		failed_files: new Set(),
		warnings_emitted: new Map(),
		tdd_cycles: new Map(),
		assertion_counts: new Map(),
		active_skills: new Set(),
		tool_call_count: 0,
	} as unknown as SessionTrajectory;
}

describe("checkDisabledTestDelta", () => {
	it("flags newly-added it.skip blocks", () => {
		commitInitial(
			"foo.test.ts",
			`it("a", () => {});\nit("b", () => {});\n`,
		);
		stageEdit(
			"foo.test.ts",
			`it("a", () => {});\nit.skip("b", () => {});\n`,
		);
		const results = checkDisabledTestDelta(makeSession(["foo.test.ts"]));
		expect(results.length).toBe(1);
		expect(results[0].name).toBe("disabled_test_delta");
		expect(results[0].severity).toBe("error");
	});

	it("does not fire when an existing skip is removed", () => {
		commitInitial(
			"foo.test.ts",
			`it.skip("a", () => {});\nit("b", () => {});\n`,
		);
		stageEdit("foo.test.ts", `it("a", () => {});\nit("b", () => {});\n`);
		expect(checkDisabledTestDelta(makeSession(["foo.test.ts"]))).toEqual([]);
	});

	it("does not fire on production source", () => {
		commitInitial("foo.ts", `function a() {}\n`);
		stageEdit("foo.ts", `function a() {}\n// xit added in comment\n`);
		expect(checkDisabledTestDelta(makeSession(["foo.ts"]))).toEqual([]);
	});
});

describe("checkTestBlockCountRegression", () => {
	it("flags removed test blocks (net negative)", () => {
		commitInitial(
			"foo.test.ts",
			`it("a", () => {});\nit("b", () => {});\nit("c", () => {});\n`,
		);
		stageEdit("foo.test.ts", `it("a", () => {});\n`);
		const results = checkTestBlockCountRegression(makeSession(["foo.test.ts"]));
		expect(results.length).toBe(1);
		expect(results[0].name).toBe("test_block_count_regression");
	});

	it("does not fire when blocks are added", () => {
		commitInitial("foo.test.ts", `it("a", () => {});\n`);
		stageEdit("foo.test.ts", `it("a", () => {});\nit("b", () => {});\n`);
		expect(checkTestBlockCountRegression(makeSession(["foo.test.ts"]))).toEqual([]);
	});
});

describe("checkAssertionStrengthWeakening", () => {
	it("flags toBe(literal) → toBeTruthy() replacement", () => {
		commitInitial(
			"foo.test.ts",
			`it("a", () => { expect(x).toBe(42); });\n`,
		);
		stageEdit(
			"foo.test.ts",
			`it("a", () => { expect(x).toBeTruthy(); });\n`,
		);
		const results = checkAssertionStrengthWeakening(makeSession(["foo.test.ts"]));
		expect(results.length).toBe(1);
		expect(results[0].name).toBe("assertion_strength_weakening");
	});

	it("does not fire when only adding assertions", () => {
		commitInitial("foo.test.ts", `it("a", () => {});\n`);
		stageEdit(
			"foo.test.ts",
			`it("a", () => { expect(x).toBeTruthy(); });\n`,
		);
		expect(checkAssertionStrengthWeakening(makeSession(["foo.test.ts"]))).toEqual([]);
	});
});

describe("checkClockMockAdded", () => {
	it("flags newly-added vi.setSystemTime calls", () => {
		commitInitial("foo.test.ts", `it("a", () => {});\n`);
		stageEdit(
			"foo.test.ts",
			`vi.setSystemTime(new Date(2024, 1, 1));\nit("a", () => {});\n`,
		);
		const results = checkClockMockAdded(makeSession(["foo.test.ts"]));
		expect(results.length).toBe(1);
		expect(results[0].name).toBe("clock_mock_added");
	});

	it("does not fire when vi.useFakeTimers was already there", () => {
		commitInitial(
			"foo.test.ts",
			`vi.useFakeTimers();\nit("a", () => {});\n`,
		);
		stageEdit(
			"foo.test.ts",
			`vi.useFakeTimers();\nit("a", () => {});\nit("b", () => {});\n`,
		);
		expect(checkClockMockAdded(makeSession(["foo.test.ts"]))).toEqual([]);
	});
});

describe("checkConventionalCommitCoherence", () => {
	it("flags fix: with comment-only diff", () => {
		commitInitial("foo.ts", `function a() { return 1; }\n`);
		stageEdit("foo.ts", `function a() { return 1; }\n// added a comment\n`);
		const results = checkConventionalCommitCoherence(
			makeSession(["foo.ts"]),
			{ type: "fix", subject: "the bug" },
		);
		expect(results.length).toBe(1);
		expect(results[0].name).toBe("commit_message_diff_mismatch");
	});

	it("flags feat: without new exports", () => {
		commitInitial("foo.ts", `export function a() { return 1; }\n`);
		stageEdit("foo.ts", `export function a() { return 2; }\n`);
		const results = checkConventionalCommitCoherence(
			makeSession(["foo.ts"]),
			{ type: "feat", subject: "x" },
		);
		expect(results.length).toBe(1);
	});

	it("does not fire when feat: introduces a new export", () => {
		commitInitial("foo.ts", `export function a() {}\n`);
		stageEdit("foo.ts", `export function a() {}\nexport function b() {}\n`);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), {
				type: "feat",
				subject: "x",
			}),
		).toEqual([]);
	});

	it("does not fire when feat: adds a named re-export from a barrel", () => {
		commitInitial("foo.ts", `export { Existing } from "./existing.js";\n`);
		stageEdit(
			"foo.ts",
			`export { Existing } from "./existing.js";\nexport { Brand } from "./brand.js";\n`,
		);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), {
				type: "feat",
				subject: "x",
			}),
		).toEqual([]);
	});

	it("does not fire when feat: adds a star re-export", () => {
		commitInitial("foo.ts", `// barrel\n`);
		stageEdit("foo.ts", `// barrel\nexport * from "./newmodule.js";\n`);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), {
				type: "feat",
				subject: "x",
			}),
		).toEqual([]);
	});

	it("does not fire when feat: adds a default export", () => {
		commitInitial("foo.ts", `// nothing\n`);
		stageEdit("foo.ts", `// nothing\nexport default function MyFeat() {}\n`);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), {
				type: "feat",
				subject: "x",
			}),
		).toEqual([]);
	});

	it("flags test: with production-source modifications", () => {
		commitInitial("foo.ts", `function a() { return 1; }\n`);
		stageEdit("foo.ts", `function a() { return 2; }\n`);
		const results = checkConventionalCommitCoherence(
			makeSession(["foo.ts"]),
			{ type: "test", subject: "x" },
		);
		expect(results.length).toBe(1);
	});

	it("does NOT flag test: for a prod file written earlier but not staged in this commit", () => {
		// prod.ts was written this session but committed earlier; only the test
		// file is staged now. The check must reason over the STAGED diff, not the
		// whole session.files_written, or it false-fires "test: touches prod".
		commitInitial("prod.ts", `export function a() { return 1; }\n`);
		commitInitial("bar.test.ts", `it("a", () => {});\n`);
		stageEdit("bar.test.ts", `it("a", () => {});\nit("b", () => {});\n`);
		const results = checkConventionalCommitCoherence(
			makeSession(["prod.ts", "bar.test.ts"]),
			{ type: "test", subject: "add b" },
		);
		expect(results).toEqual([]);
	});

	it("returns empty when no message", () => {
		expect(checkConventionalCommitCoherence(makeSession([]), null)).toEqual([]);
	});

	it("does NOT flag deletion-only fix: commits", () => {
		// A `fix:` commit that removes broken code is a real fix even though
		// the added side of the diff is empty. Inspect removed lines too;
		// only flag when both halves are comment/whitespace-only.
		commitInitial("foo.ts", `function a() { console.log("buggy debug line"); return 1; }\n`);
		stageEdit("foo.ts", `function a() { return 1; }\n`);
		const results = checkConventionalCommitCoherence(
			makeSession(["foo.ts"]),
			{ type: "fix", subject: "remove debug" },
		);
		expect(results).toEqual([]);
	});

	it("still flags fix: when both added and removed are comment-only", () => {
		commitInitial("foo.ts", `// old comment\nfunction a() { return 1; }\n`);
		stageEdit("foo.ts", `// new comment\nfunction a() { return 1; }\n`);
		const results = checkConventionalCommitCoherence(
			makeSession(["foo.ts"]),
			{ type: "fix", subject: "the bug" },
		);
		expect(results.length).toBe(1);
	});
});

describe("checkReintroducesRemovedCode", () => {
	it("flags re-introduction of a previously-removed console.log", () => {
		commitInitial("foo.ts", `function a() { console.log("debug-marker-xyz-123"); }\n`);
		// Remove the console.log in a second commit
		writeFileSync(join(repoDir, "foo.ts"), `function a() { return 1; }\n`);
		git(["add", "."]);
		git(["commit", "-q", "-m", "remove-debug"]);
		// Stage a re-introduction
		stageEdit("foo.ts", `function a() { console.log("debug-marker-xyz-123"); return 1; }\n`);
		const results = checkReintroducesRemovedCode(makeSession(["foo.ts"]));
		expect(results.length).toBe(1);
		expect(results[0].name).toBe("reintroduces_removed_code");
	});

	it("does not fire when the line was never previously removed", () => {
		commitInitial("foo.ts", `function a() { return 1; }\n`);
		stageEdit(
			"foo.ts",
			`function a() { console.log("a-fresh-debug-line-here-001"); return 1; }\n`,
		);
		expect(checkReintroducesRemovedCode(makeSession(["foo.ts"]))).toEqual([]);
	});

	it("only inspects loud-marker patterns (skips plain code re-additions)", () => {
		commitInitial("foo.ts", `function helper() { return computeValue(); }\n`);
		writeFileSync(join(repoDir, "foo.ts"), `function helper() { return 1; }\n`);
		git(["add", "."]);
		git(["commit", "-q", "-m", "cleanup"]);
		stageEdit("foo.ts", `function helper() { return computeValue(); }\n`);
		// This is a re-introduction, but no loud marker — check skips it.
		expect(checkReintroducesRemovedCode(makeSession(["foo.ts"]))).toEqual([]);
	});
});

describe("checkDoneWithoutVerify", () => {
	it("flags source edits with no test runs", () => {
		const session = makeSession(["foo.ts"]);
		const results = checkDoneWithoutVerify(session);
		expect(results.length).toBe(1);
		expect(results[0].name).toBe("done_without_verify");
	});

	it("does not fire when test_runs is non-empty", () => {
		const session = makeSession(["foo.ts"]);
		session.test_runs.set("foo.test.ts", { status: "pass", at_step: 1 });
		expect(checkDoneWithoutVerify(session)).toEqual([]);
	});

	it("does not fire when only test files were edited", () => {
		const session = makeSession(["foo.test.ts"]);
		expect(checkDoneWithoutVerify(session)).toEqual([]);
	});

	it("does not fire when files_written is empty", () => {
		const session = makeSession([]);
		expect(checkDoneWithoutVerify(session)).toEqual([]);
	});

	it("does not fire on docs-only / markdown-only commits", () => {
		const session = makeSession(["README.md", "docs/intro.mdx"]);
		expect(checkDoneWithoutVerify(session)).toEqual([]);
	});

	it("does not fire on config-only / lockfile-only commits", () => {
		const session = makeSession([
			"package.json",
			"package-lock.json",
			"tsconfig.json",
			".github/workflows/ci.yml",
		]);
		expect(checkDoneWithoutVerify(session)).toEqual([]);
	});

	it("still fires when one source file is mixed with docs", () => {
		const session = makeSession(["README.md", "src/lib/foo.ts"]);
		expect(checkDoneWithoutVerify(session).length).toBe(1);
	});
});
