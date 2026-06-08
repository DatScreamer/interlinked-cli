// Behavioral coverage for the two config-gated coverage phase helpers extracted
// from the PreToolUse pipeline orchestrator. `checkCoverageWrite` (per-edit) and
// `checkCommitGate` (commit-time) are mocked at the import boundary so each
// helper's gating / merge logic is driven deterministically without a real
// suite, git, or overlay.

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent } from "../types.js";
import type { ServerRuntime } from "./runtime-context.js";

vi.mock("../evaluator/coverage-write-guard.js", () => ({
	checkCoverageWrite: vi.fn(async (): Promise<HarnessDecision | null> => null),
}));

vi.mock("../evaluator/commit-gate.js", () => ({
	checkCommitGate: vi.fn(async (): Promise<HarnessDecision | null> => null),
}));

import { checkCommitGate } from "../evaluator/commit-gate.js";
import { checkCoverageWrite } from "../evaluator/coverage-write-guard.js";
import { runCommitGate, runCoverageWriteGate } from "./pre-tool-coverage-gates.js";

const mCheckCoverage = checkCoverageWrite as unknown as Mock;
const mCheckCommit = checkCommitGate as unknown as Mock;

function ev(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "claude",
		timestamp: "2026-06-07T00:00:00.000Z",
		...partial,
	};
}

function ctxWith(perEditEnabled: boolean): ServerRuntime {
	const rules = {
		per_edit_coverage: perEditEnabled
			? { enabled: true, mode: "block", budget_ms: 25_000, languages: ["js", "ts"] }
			: undefined,
	} as unknown as GuardRulesConfig;
	return { rules } as unknown as ServerRuntime;
}

function allow(warnings?: string[]): HarnessDecision {
	return warnings ? { decision: "allow", warnings } : { decision: "allow" };
}

beforeEach(() => {
	vi.clearAllMocks();
	mCheckCoverage.mockResolvedValue(null);
	mCheckCommit.mockResolvedValue(null);
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("runCoverageWriteGate", () => {
	it("no-op (guard never called) when per_edit_coverage is absent", async () => {
		const decision = await runCoverageWriteGate(
			ctxWith(false),
			ev({ tool_name: "Write" }),
			allow(),
		);
		expect(decision).toBeNull();
		expect(mCheckCoverage).not.toHaveBeenCalled();
	});

	it("no-op when the pre-decision is already a block", async () => {
		const decision = await runCoverageWriteGate(ctxWith(true), ev({ tool_name: "Write" }), {
			decision: "block",
			reason: "upstream",
		});
		expect(decision).toBeNull();
		expect(mCheckCoverage).not.toHaveBeenCalled();
	});

	it("returns the guard block and copies pre-decision warnings onto it", async () => {
		mCheckCoverage.mockResolvedValue({ decision: "block", reason: "R" });
		const decision = await runCoverageWriteGate(
			ctxWith(true),
			ev({ tool_name: "Write" }),
			allow(["PRE"]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.warnings).toEqual(["PRE"]);
	});

	it("returns null (continue) when the guard finds nothing", async () => {
		const decision = await runCoverageWriteGate(
			ctxWith(true),
			ev({ tool_name: "Write" }),
			allow(),
		);
		expect(decision).toBeNull();
		expect(mCheckCoverage).toHaveBeenCalledOnce();
	});
});

describe("runCommitGate", () => {
	it("no-op (gate never called) when per_edit_coverage is absent", async () => {
		const decision = await runCommitGate(
			ctxWith(false),
			ev({ tool_name: "Bash", tool_input: { command: "git commit -m x" } }),
			allow(),
		);
		expect(decision).toBeNull();
		expect(mCheckCommit).not.toHaveBeenCalled();
	});

	it("no-op for a non-Bash tool even when enabled", async () => {
		const decision = await runCommitGate(ctxWith(true), ev({ tool_name: "Write" }), allow());
		expect(decision).toBeNull();
		expect(mCheckCommit).not.toHaveBeenCalled();
	});

	it("no-op when the pre-decision is already a block", async () => {
		const decision = await runCommitGate(
			ctxWith(true),
			ev({ tool_name: "Bash", tool_input: { command: "git commit -m x" } }),
			{ decision: "block", reason: "upstream" },
		);
		expect(decision).toBeNull();
		expect(mCheckCommit).not.toHaveBeenCalled();
	});

	it("returns the gate block when enabled + Bash + the gate blocks", async () => {
		mCheckCommit.mockResolvedValue({ decision: "block", reason: "[interlinked:commit-gate] BLOCKED" });
		const decision = await runCommitGate(
			ctxWith(true),
			ev({ tool_name: "Bash", tool_input: { command: "git commit -m x" } }),
			allow(),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toContain("[interlinked:commit-gate]");
		expect(mCheckCommit).toHaveBeenCalledOnce();
	});

	it("merges pre-decision warnings ahead of the gate's own warnings", async () => {
		mCheckCommit.mockResolvedValue({
			decision: "block",
			reason: "R",
			warnings: ["GATE-NO-VERIFY"],
		});
		const decision = await runCommitGate(
			ctxWith(true),
			ev({ tool_name: "Bash", tool_input: { command: "git commit -m x --no-verify" } }),
			allow(["PRE"]),
		);
		expect(decision?.warnings).toEqual(["PRE", "GATE-NO-VERIFY"]);
	});

	it("returns null (continue) when the gate finds nothing (clean commit)", async () => {
		const decision = await runCommitGate(
			ctxWith(true),
			ev({ tool_name: "Bash", tool_input: { command: "git commit -m x" } }),
			allow(),
		);
		expect(decision).toBeNull();
		expect(mCheckCommit).toHaveBeenCalledOnce();
	});
});
