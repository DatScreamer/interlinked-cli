import { afterEach, describe, expect, it } from "vitest";
import { SessionTracker } from "../session-state.js";
import { fingerprintBlock } from "../trajectory/block-fingerprint.js";
import type { HarnessEvent, SessionTrajectory } from "../types.js";
import type { GitReader } from "./commit-laundering-gate.js";
import { runCommitLaunderingGate } from "./commit-laundering-gate.js";

const NOW = 2_000_000;

function commitEvent(command = 'git commit -m "wip"'): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command },
		cwd: "/repo",
		timestamp: "t",
	};
}

/** A session whose armed set contains one blocked-this-session rule. */
function sessionArmedWith(ruleId: string): SessionTrajectory {
	const s = new SessionTracker().recordEvent(commitEvent("git status"));
	s.block_fingerprints = [
		fingerprintBlock({ ruleId, content: "eval(userInput)", target: "src/danger.ts", atMs: NOW }),
	];
	return s;
}

function fakeGit(map: Record<string, string | null>): GitReader {
	return (_root, args) => {
		const key = args.join(" ");
		return key in map ? (map[key] ?? null) : null;
	};
}

const STAGED_WITH_EVAL = "export function run(userInput) {\n  return eval(userInput);\n}\n";
const HEAD_NO_EVAL = "export function run(userInput) {\n  return safeParse(userInput);\n}\n";

const deps = (git: GitReader) => ({ git, resolveRepoRoot: () => "/repo", nowMs: NOW });

afterEach(() => {
	delete process.env.INTERLINKED_DISABLE_LAUNDERING_GATE;
});

describe("runCommitLaunderingGate — blocks laundering", () => {
	it("blocks a commit that stages a still-present violation of a rule blocked this session", () => {
		const git = fakeGit({
			"diff --cached --name-only": "src/danger.ts",
			"show :src/danger.ts": STAGED_WITH_EVAL,
			"show HEAD:src/danger.ts": HEAD_NO_EVAL,
		});
		const d = runCommitLaunderingGate(commitEvent(), sessionArmedWith("eval_usage"), deps(git));
		expect(d?.decision).toBe("block");
		expect(d?.rule_id).toBe("workaround_laundering");
		expect(d?.reason).toContain("eval_usage");
		expect(d?.reason).toContain("src/danger.ts");
	});
});

describe("runCommitLaunderingGate — does NOT block (zero-FP guarantees)", () => {
	it("allows a legitimately FIXED commit (violation no longer present)", () => {
		const git = fakeGit({
			"diff --cached --name-only": "src/danger.ts",
			"show :src/danger.ts": HEAD_NO_EVAL, // fixed — no eval
			"show HEAD:src/danger.ts": HEAD_NO_EVAL,
		});
		expect(runCommitLaunderingGate(commitEvent(), sessionArmedWith("eval_usage"), deps(git))).toBeNull();
	});

	it("allows a PRE-EXISTING violation (introduced-only: present in HEAD too)", () => {
		const git = fakeGit({
			"diff --cached --name-only": "src/danger.ts",
			"show :src/danger.ts": STAGED_WITH_EVAL,
			"show HEAD:src/danger.ts": STAGED_WITH_EVAL, // eval was already there
		});
		expect(runCommitLaunderingGate(commitEvent(), sessionArmedWith("eval_usage"), deps(git))).toBeNull();
	});

	it("allows when the violation's rule was NOT blocked this session (unarmed)", () => {
		const git = fakeGit({
			"diff --cached --name-only": "src/danger.ts",
			"show :src/danger.ts": STAGED_WITH_EVAL,
			"show HEAD:src/danger.ts": HEAD_NO_EVAL,
		});
		// armed with a DIFFERENT rule — the eval is real but not a laundered block.
		expect(runCommitLaunderingGate(commitEvent(), sessionArmedWith("some_other_rule"), deps(git))).toBeNull();
	});

	it("allows when nothing is armed", () => {
		const s = new SessionTracker().recordEvent(commitEvent("git status"));
		const git = fakeGit({ "diff --cached --name-only": "src/danger.ts" });
		expect(runCommitLaunderingGate(commitEvent(), s, deps(git))).toBeNull();
	});

	it("is a no-op when the command is not a git commit", () => {
		const git = fakeGit({});
		expect(runCommitLaunderingGate(commitEvent("git status"), sessionArmedWith("eval_usage"), deps(git))).toBeNull();
	});

	it("honors the env bypass", () => {
		process.env.INTERLINKED_DISABLE_LAUNDERING_GATE = "1";
		const git = fakeGit({
			"diff --cached --name-only": "src/danger.ts",
			"show :src/danger.ts": STAGED_WITH_EVAL,
			"show HEAD:src/danger.ts": HEAD_NO_EVAL,
		});
		expect(runCommitLaunderingGate(commitEvent(), sessionArmedWith("eval_usage"), deps(git))).toBeNull();
	});

	it("fails open when git reads fail", () => {
		const git = fakeGit({}); // every read → null
		expect(runCommitLaunderingGate(commitEvent(), sessionArmedWith("eval_usage"), deps(git))).toBeNull();
	});
});
