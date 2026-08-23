import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionTracker } from "../session-state.js";
import { fingerprintBlock } from "../trajectory/block-fingerprint.js";
import type { HarnessEvent, SessionTrajectory } from "../types.js";
import type { GitReader } from "./commit-laundering-gate.js";
import { runCommitLaunderingGate } from "./commit-laundering-gate.js";

const NOW = 2_000_000;

function commitEvent(command = 'git commit -m "wip"', cwd = "/repo"): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command },
		cwd,
		timestamp: "t",
	};
}

function sessionArmedWith(ruleId: string): SessionTrajectory {
	const s = new SessionTracker().recordEvent(commitEvent("git status"));
	s.block_fingerprints = [
		fingerprintBlock({ ruleId, content: "eval(userInput)", target: "src/danger.ts", atMs: NOW }),
	];
	return s;
}

function sessionUnarmed(): SessionTrajectory {
	const s = new SessionTracker().recordEvent(commitEvent("git status"));
	s.block_fingerprints = [];
	return s;
}

const STAGED_WITH_EVAL = "export function run(userInput) {\n  return eval(userInput);\n}\n";

afterEach(() => {
	delete process.env.INTERLINKED_DISABLE_LAUNDERING_GATE;
});

// ---------------------------------------------------------------------------
// realGit / realRepoRoot — exercised only when deps.git / deps.resolveRepoRoot
// are NOT supplied, so these tests use a REAL temp git repo and no deps
// overrides at all. Any mutation to the "git" binary name, the -C args array,
// the exec options (encoding/maxBuffer), or the try/catch bodies breaks the
// real exec chain and the expected block never fires.
// ---------------------------------------------------------------------------
describe("runCommitLaunderingGate — real git / real repo root (default deps)", () => {
	it("blocks via the real execFileSync git chain (rev-parse, diff --cached, show)", () => {
		const dir = mkdtempSync(join(tmpdir(), "laundering-gate-w45-"));
		try {
			execFileSync("git", ["init"], { cwd: dir });
			execFileSync("git", ["config", "user.email", "a@example.com"], { cwd: dir });
			execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
			writeFileSync(join(dir, "bad.js"), STAGED_WITH_EVAL);
			execFileSync("git", ["add", "bad.js"], { cwd: dir });

			const session = sessionArmedWith("eval_usage");
			const event = commitEvent('git commit -m "wip"', dir);
			const result = runCommitLaunderingGate(event, session, { nowMs: 0 });

			expect(result?.decision).toBe("block");
			expect(result?.rule_id).toBe("workaround_laundering");
			expect(result?.reason).toContain("bad.js");
			expect(result?.reason).toContain("eval_usage");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// launderingHitInFile — staged === null early return.
// ---------------------------------------------------------------------------
describe("runCommitLaunderingGate — staged===null short-circuit vs later files", () => {
	it("skips a file whose staged blob read is null and still catches a LATER violation", () => {
		const git: GitReader = (_root, args) => {
			const key = args.join(" ");
			if (key === "diff --cached --name-only") return "missing.js\nviolates.js";
			if (key === "show :missing.js") return null; // unreadable staged blob
			if (key === "show :violates.js") return STAGED_WITH_EVAL;
			if (key.startsWith("show HEAD:")) return null; // both new files
			return null;
		};
		const result = runCommitLaunderingGate(commitEvent(), sessionArmedWith("eval_usage"), {
			git,
			resolveRepoRoot: () => "/repo",
			nowMs: NOW,
		});
		expect(result?.decision).toBe("block");
		expect(result?.reason).toContain("violates.js");
	});
});

// ---------------------------------------------------------------------------
// launderingReason — every string fragment must survive, or the message
// silently loses the provenance story it exists to carry.
// ---------------------------------------------------------------------------
describe("runCommitLaunderingGate — launderingReason message fragments", () => {
	it("includes every fragment of the block reason", () => {
		const git: GitReader = (_root, args) => {
			const key = args.join(" ");
			if (key === "diff --cached --name-only") return "src/danger.ts";
			if (key === "show :src/danger.ts") return STAGED_WITH_EVAL;
			if (key === "show HEAD:src/danger.ts") return null;
			return null;
		};
		const result = runCommitLaunderingGate(commitEvent(), sessionArmedWith("eval_usage"), {
			git,
			resolveRepoRoot: () => "/repo",
			nowMs: NOW,
		});
		expect(result?.reason).toContain(
			"this session, and the violation is still present (introduced vs HEAD). The block was not advisory — ",
		);
		expect(result?.reason).toContain(
			"routing the refused change into a commit through another channel defeats the guarantee it protects. ",
		);
		expect(result?.reason).toContain("Fix the flagged issue in src/danger.ts, or if the check itself is wrong, report it.");
		expect(result?.reason).toContain("One-time bypass: INTERLINKED_DISABLE_LAUNDERING_GATE=1.");
	});
});

// ---------------------------------------------------------------------------
// armed.length === 0 — the early return must happen BEFORE any git/resolveRoot
// call. Spy on both deps and assert they are never invoked when unarmed.
// ---------------------------------------------------------------------------
describe("runCommitLaunderingGate — unarmed session never touches git", () => {
	it("returns null without calling resolveRepoRoot or git when nothing is armed", () => {
		let resolveCalls = 0;
		let gitCalls = 0;
		const result = runCommitLaunderingGate(commitEvent(), sessionUnarmed(), {
			resolveRepoRoot: () => {
				resolveCalls++;
				return "/repo";
			},
			git: (_root, _args) => {
				gitCalls++;
				return "";
			},
			nowMs: NOW,
		});
		expect(result).toBeNull();
		expect(resolveCalls).toBe(0);
		expect(gitCalls).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// !repoRoot — the early return must happen BEFORE the diff --cached git call.
// ---------------------------------------------------------------------------
describe("runCommitLaunderingGate — missing repo root never calls git for staged list", () => {
	it("returns null without calling git when resolveRepoRoot yields null", () => {
		let gitCalls = 0;
		const result = runCommitLaunderingGate(commitEvent(), sessionArmedWith("eval_usage"), {
			resolveRepoRoot: () => null,
			git: (_root, _args) => {
				gitCalls++;
				return "";
			},
			nowMs: NOW,
		});
		expect(result).toBeNull();
		expect(gitCalls).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// .slice(0, MAX_STAGED_FILES) — a violation past the 200-file cap must NOT
// block; removing the slice (with or without the filter) makes it block.
// ---------------------------------------------------------------------------
describe("runCommitLaunderingGate — MAX_STAGED_FILES cap", () => {
	it("does not evaluate the 201st staged file", () => {
		const keep = Array.from({ length: 200 }, (_, i) => `keep${i}.js`);
		const nameList = [...keep, "target.js"].join("\n");
		const git: GitReader = (_root, args) => {
			const key = args.join(" ");
			if (key === "diff --cached --name-only") return nameList;
			if (key === "show :target.js") return STAGED_WITH_EVAL;
			if (key.startsWith("show :")) return "console.log('fine');\n";
			if (key.startsWith("show HEAD:")) return null;
			return null;
		};
		const result = runCommitLaunderingGate(commitEvent(), sessionArmedWith("eval_usage"), {
			git,
			resolveRepoRoot: () => "/repo",
			nowMs: NOW,
		});
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// `if (hit)` — must not short-circuit truthy on the first (non-hitting) file
// and skip a real violation on a later file.
// ---------------------------------------------------------------------------
describe("runCommitLaunderingGate — hit check does not fire on a clean first file", () => {
	it("blocks on the second staged file after a clean first file", () => {
		const git: GitReader = (_root, args) => {
			const key = args.join(" ");
			if (key === "diff --cached --name-only") return "a.js\nb.js";
			if (key === "show :a.js") return "console.log('clean');\n";
			if (key === "show :b.js") return STAGED_WITH_EVAL;
			if (key.startsWith("show HEAD:")) return null;
			return null;
		};
		const result = runCommitLaunderingGate(commitEvent(), sessionArmedWith("eval_usage"), {
			git,
			resolveRepoRoot: () => "/repo",
			nowMs: NOW,
		});
		expect(result?.decision).toBe("block");
		expect(result?.reason).toContain("b.js");
	});
});

// ---------------------------------------------------------------------------
// .map((s) => s.trim()) on the staged file-name list — an untrimmed name
// changes the `show :<rel>` key and misses the violation.
// ---------------------------------------------------------------------------
describe("runCommitLaunderingGate — staged file names are trimmed", () => {
	it("finds the violation for a name-list entry with surrounding whitespace", () => {
		const git: GitReader = (_root, args) => {
			const key = args.join(" ");
			if (key === "diff --cached --name-only") return " bad.js ";
			if (key === "show :bad.js") return STAGED_WITH_EVAL;
			if (key === "show HEAD:bad.js") return null;
			return null; // any untrimmed key (e.g. "show : bad.js ") misses
		};
		const result = runCommitLaunderingGate(commitEvent(), sessionArmedWith("eval_usage"), {
			git,
			resolveRepoRoot: () => "/repo",
			nowMs: NOW,
		});
		expect(result?.decision).toBe("block");
		expect(result?.reason).toContain("bad.js");
	});
});
