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

vi.mock("../mutation/gate.js", () => ({
	runPerEditMutationGate: vi.fn(async (): Promise<HarnessDecision | null> => null),
}));

vi.mock("../mutation/manifest.js", () => ({
	loadManifest: vi.fn(() => null),
	emptyManifest: vi.fn(() => ({ mutants: [] })),
	// The wiring hands the gate a real fs persister (measured-clean passes save
	// the manifest + append a receipt); a noop factory keeps these tests disk-free.
	makeManifestPersister: vi.fn(() => vi.fn()),
}));

vi.mock("../mutation/cloud-runner.js", () => ({
	createCloudMutationRunner: vi.fn(() => ({ runOverlay: vi.fn() })),
}));

import { checkCommitGate } from "../evaluator/commit-gate.js";
import { checkCoverageWrite } from "../evaluator/coverage-write-guard.js";
import { createCloudMutationRunner } from "../mutation/cloud-runner.js";
import { runPerEditMutationGate } from "../mutation/gate.js";
import { runCommitGate, runCoverageWriteGate, runMutationWriteGate } from "./pre-tool-coverage-gates.js";

const mCheckCoverage = checkCoverageWrite as unknown as Mock;
const mCheckCommit = checkCommitGate as unknown as Mock;
const mMutation = runPerEditMutationGate as unknown as Mock;
const mCreateRunner = createCloudMutationRunner as unknown as Mock;

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

function ctxMutation(cfg: unknown): ServerRuntime {
	return {
		rules: { per_edit_mutation: cfg } as unknown as GuardRulesConfig,
		cwd: "/tmp/harness-mutation-test",
	} as unknown as ServerRuntime;
}

function allow(warnings?: string[]): HarnessDecision {
	return warnings ? { decision: "allow", warnings } : { decision: "allow" };
}

beforeEach(() => {
	vi.clearAllMocks();
	mCheckCoverage.mockResolvedValue(null);
	mCheckCommit.mockResolvedValue(null);
	mMutation.mockResolvedValue(null);
	mCreateRunner.mockReturnValue({ runOverlay: vi.fn() });
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

	it("PROPAGATES a fail-loud allow-decision's warning onto the running decision (not dropped)", async () => {
		// The guard degraded (no coverage provider) → it returns ALLOW + a warning
		// rather than a bare null. The gate must NOT drop it: it merges the warning
		// onto preDecision (so it rides to the agent) and returns null to continue
		// the pipeline. This is the regression pin against the silent-fail-open bug
		// where `if (!coverageBlock) return null` discarded any non-block decision.
		const COV_WARN = "[interlinked:coverage] WARNING: gate ON for ts but could not run — install @vitest/coverage-v8.";
		mCheckCoverage.mockResolvedValue({ decision: "allow", warnings: [COV_WARN] });
		const preDecision = allow();
		const decision = await runCoverageWriteGate(ctxWith(true), ev({ tool_name: "Write" }), preDecision);
		// Continues the pipeline (does not short-circuit on a non-block)…
		expect(decision).toBeNull();
		// …but the warning was merged onto the running decision the pipeline returns.
		expect(preDecision.warnings).toEqual([COV_WARN]);
	});

	it("merges a fail-loud allow's warning AFTER any pre-existing warnings (order preserved)", async () => {
		const COV_WARN = "[interlinked:coverage] WARNING: this edit was NOT coverage-checked.";
		mCheckCoverage.mockResolvedValue({ decision: "allow", warnings: [COV_WARN] });
		const preDecision = allow(["PRE"]);
		const decision = await runCoverageWriteGate(ctxWith(true), ev({ tool_name: "Write" }), preDecision);
		expect(decision).toBeNull();
		expect(preDecision.warnings).toEqual(["PRE", COV_WARN]);
	});

	it("an allow-decision WITHOUT warnings is a clean continue (no spurious warning added)", async () => {
		mCheckCoverage.mockResolvedValue({ decision: "allow" });
		const preDecision = allow();
		const decision = await runCoverageWriteGate(ctxWith(true), ev({ tool_name: "Write" }), preDecision);
		expect(decision).toBeNull();
		expect(preDecision.warnings).toBeUndefined();
	});

	it("a block carrying its OWN warnings keeps them, with pre-decision warnings first", async () => {
		mCheckCoverage.mockResolvedValue({ decision: "block", reason: "R", warnings: ["COV-BLOCK"] });
		const decision = await runCoverageWriteGate(
			ctxWith(true),
			ev({ tool_name: "Write" }),
			allow(["PRE"]),
		);
		expect(decision?.decision).toBe("block");
		// Merge, not overwrite: the old code clobbered the block's own warnings.
		expect(decision?.warnings).toEqual(["PRE", "COV-BLOCK"]);
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

describe("runMutationWriteGate", () => {
	it("no-op (gate never called) when the pre-decision is already a block", async () => {
		const decision = await runMutationWriteGate(
			ctxMutation({ enabled: true, mode: "block" }),
			ev({ tool_name: "Write" }),
			{ decision: "block", reason: "upstream" },
		);
		expect(decision).toBeNull();
		expect(mMutation).not.toHaveBeenCalled();
	});

	it("no-op (default OFF, gate never called) when per_edit_mutation is absent", async () => {
		const decision = await runMutationWriteGate(ctxMutation(undefined), ev({ tool_name: "Write" }), allow());
		expect(decision).toBeNull();
		expect(mMutation).not.toHaveBeenCalled();
	});

	it("no-op when per_edit_mutation is present but disabled (the inert default path)", async () => {
		const decision = await runMutationWriteGate(
			ctxMutation({ enabled: false, mode: "block" }),
			ev({ tool_name: "Write" }),
			allow(),
		);
		expect(decision).toBeNull();
		expect(mMutation).not.toHaveBeenCalled();
	});

	it("enabled + no runner_url: runs the gate with a NULL runner and builds no cloud runner", async () => {
		mMutation.mockResolvedValue(null);
		const decision = await runMutationWriteGate(
			ctxMutation({ enabled: true, mode: "block" }),
			ev({ tool_name: "Write" }),
			allow(),
		);
		expect(decision).toBeNull();
		expect(mMutation).toHaveBeenCalledOnce();
		expect(mMutation.mock.calls[0]?.[0]?.runner).toBeNull();
		expect(mCreateRunner).not.toHaveBeenCalled();
	});

	it("enabled + runner_url: lazily builds the cloud runner and passes it to the gate", async () => {
		mMutation.mockResolvedValue(null);
		await runMutationWriteGate(
			ctxMutation({ enabled: true, mode: "block", runner_url: "https://runner.example" }),
			ev({ tool_name: "Write" }),
			allow(),
		);
		expect(mCreateRunner).toHaveBeenCalledOnce();
		expect(mMutation.mock.calls[0]?.[0]?.runner).not.toBeNull();
	});

	it("returns the gate's block, merging pre-decision warnings onto it", async () => {
		mMutation.mockResolvedValue({ decision: "block", reason: "[mutation] survivor", warnings: ["MUT"] });
		const decision = await runMutationWriteGate(
			ctxMutation({ enabled: true, mode: "block" }),
			ev({ tool_name: "Write" }),
			allow(["PRE"]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.warnings).toEqual(["PRE", "MUT"]);
	});

	it("merges a not-measured allow's warning onto preDecision and continues (null)", async () => {
		const MUT_WARN = "[mutation:not-measured] cloud runner unavailable";
		mMutation.mockResolvedValue({ decision: "allow", warnings: [MUT_WARN] });
		const preDecision = allow();
		const decision = await runMutationWriteGate(
			ctxMutation({ enabled: true, mode: "block" }),
			ev({ tool_name: "Write" }),
			preDecision,
		);
		expect(decision).toBeNull();
		expect(preDecision.warnings).toEqual([MUT_WARN]);
	});

	it("a bare allow with no warnings is a clean continue (no spurious warning)", async () => {
		mMutation.mockResolvedValue({ decision: "allow" });
		const preDecision = allow();
		const decision = await runMutationWriteGate(
			ctxMutation({ enabled: true, mode: "block" }),
			ev({ tool_name: "Write" }),
			preDecision,
		);
		expect(decision).toBeNull();
		expect(preDecision.warnings).toBeUndefined();
	});
});
