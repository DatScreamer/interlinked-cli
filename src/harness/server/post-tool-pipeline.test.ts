// Behavioral coverage for the PostToolUse pipeline orchestrator.
//
// Every sibling check module is mocked at the import boundary so each branch
// of `runPostToolPipeline` is driven deterministically. `node:fs` is mocked
// so the marker-write / pending-write error paths are reachable. We import
// the real `./post-tool-pipeline.js` and assert the aggregated decision it
// returns (warnings / summary / check_results / timing / phase_breakdown).
//
// `makeCtx` / `makeRules` take loose record literals and cast the whole
// object once (`as unknown as ...`) so the test can supply just the handful
// of fields the orchestrator reads without satisfying every field of the
// large runtime interfaces — and without per-property `undefined`-widening
// casts that exactOptionalPropertyTypes rejects.

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type {
	CheckResultEntry,
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
import { runPostToolPipeline } from "./post-tool-pipeline.js";
import type { PerFileCheckCtx } from "./post-tool-file-checks.js";
import type { ServerRuntime } from "./runtime-context.js";

// ---------------------------------------------------------------------------
// Module mocks (vitest hoists these above the real-module imports below).
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
	mkdirSync: vi.fn(),
	readFileSync: vi.fn(() => "file contents"),
	unlinkSync: vi.fn(),
	writeFileSync: vi.fn(),
}));

vi.mock("../check-engine/index.js", () => ({
	getOrCreateEngine: vi.fn(() => ({ isToolAvailable: vi.fn(() => true) })),
}));

vi.mock("../content-scanner/post-scan.js", () => ({
	runPostToolScan: vi.fn(async () => ({ warnings: [], findings: [] })),
}));

vi.mock("../evaluator.js", () => ({
	evaluatePostToolUse: vi.fn((): HarnessDecision => ({ decision: "allow" })),
}));

vi.mock("../failure-channels.js", () => ({
	runFailureChannels: vi.fn(() => null),
}));

vi.mock("../server-tdd-cycle.js", () => ({
	detectTestRunFile: vi.fn(() => null),
	recordTestRunCycle: vi.fn(),
}));

vi.mock("../server-tool-helpers.js", () => ({
	extractAllEditedFilePaths: vi.fn(() => []),
}));

vi.mock("../skip-paths.js", () => ({
	shouldSkipPath: vi.fn(() => false),
}));

vi.mock("../tool-result-checks.js", () => ({
	checkSilentFailure: vi.fn(() => null),
	checkContextBloat: vi.fn(() => null),
	consecutiveFailureWarning: vi.fn(() => null),
	formatSilentFailureWarning: vi.fn(() => "SILENT"),
	formatBloatWarning: vi.fn(() => "BLOAT"),
}));

vi.mock("./post-tool-file-checks.js", () => ({
	runPerFileChecks: vi.fn(),
}));

// Bind to the mocked exports so each test can re-program return values.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { getOrCreateEngine } from "../check-engine/index.js";
import { runPostToolScan } from "../content-scanner/post-scan.js";
import { evaluatePostToolUse } from "../evaluator.js";
import { runFailureChannels } from "../failure-channels.js";
import { detectTestRunFile, recordTestRunCycle } from "../server-tdd-cycle.js";
import { extractAllEditedFilePaths } from "../server-tool-helpers.js";
import { shouldSkipPath } from "../skip-paths.js";
import {
	checkContextBloat,
	checkSilentFailure,
	consecutiveFailureWarning,
} from "../tool-result-checks.js";
import { runPerFileChecks } from "./post-tool-file-checks.js";

const mEvaluate = evaluatePostToolUse as unknown as Mock;
const mPostScan = runPostToolScan as unknown as Mock;
const mFailureChannels = runFailureChannels as unknown as Mock;
const mDetectTestRun = detectTestRunFile as unknown as Mock;
const mRecordTestRunCycle = recordTestRunCycle as unknown as Mock;
const mExtractPaths = extractAllEditedFilePaths as unknown as Mock;
const mShouldSkip = shouldSkipPath as unknown as Mock;
const mCheckSilent = checkSilentFailure as unknown as Mock;
const mCheckBloat = checkContextBloat as unknown as Mock;
const mConsecutive = consecutiveFailureWarning as unknown as Mock;
const mGetEngine = getOrCreateEngine as unknown as Mock;
const mRunPerFile = runPerFileChecks as unknown as Mock;
const mExistsSync = existsSync as unknown as Mock;
const mMkdir = mkdirSync as unknown as Mock;
const mReadFile = readFileSync as unknown as Mock;
const mUnlink = unlinkSync as unknown as Mock;
const mWriteFile = writeFileSync as unknown as Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function ev(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "s",
		agent_source: "claude",
		timestamp: "2026-04-23T00:00:00.000Z",
		...partial,
	};
}

function makeSession(partial: Record<string, unknown> = {}): SessionTrajectory {
	return {
		test_runs: new Map(),
		silent_failure_warned: new Set<string>(),
		bloat_warned: new Set<string>(),
		consecutive_tool_failures: new Map<string, number>(),
		acknowledged_checks: new Set<string>(),
		tool_call_count: 3,
		...partial,
	} as unknown as SessionTrajectory;
}

function makeRules(partial: Record<string, unknown> = {}): GuardRulesConfig {
	return {
		rules: [{ id: "r1" }, { id: "r2" }],
		...partial,
	} as unknown as GuardRulesConfig;
}

function makeCtx(overrides: Record<string, unknown> = {}): ServerRuntime {
	return {
		cwd: "/repo",
		interlinkedDir: "/repo/.interlinked",
		rules: makeRules(),
		cohort: {},
		reservations: {},
		contentScanner: undefined,
		compiledAllowlist: [],
		trigramIndex: null,
		fileContentCache: { set: vi.fn() },
		log: vi.fn(),
		...overrides,
	} as unknown as ServerRuntime;
}

/** A minimal but fully-typed structured finding (the orchestrator only reads
 *  `allCheckResults.length`, never these fields). */
function finding(): CheckResultEntry {
	return {
		source: "quality",
		name: "x",
		severity: "warning",
		message: "m",
		determinism: "heuristic",
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	// Re-establish default mock implementations cleared above.
	mShouldSkip.mockReturnValue(false);
	mEvaluate.mockReturnValue({ decision: "allow" } satisfies HarnessDecision);
	mFailureChannels.mockReturnValue(null);
	mPostScan.mockResolvedValue({ warnings: [], findings: [] });
	mDetectTestRun.mockReturnValue(null);
	mExtractPaths.mockReturnValue([]);
	mCheckSilent.mockReturnValue(null);
	mCheckBloat.mockReturnValue(null);
	mConsecutive.mockReturnValue(null);
	mGetEngine.mockReturnValue({ isToolAvailable: vi.fn(() => true) });
	mRunPerFile.mockResolvedValue(undefined);
	mExistsSync.mockReturnValue(true);
	mReadFile.mockReturnValue("file contents");
});

// ---------------------------------------------------------------------------
// 1. skip_paths short-circuit
// ---------------------------------------------------------------------------

describe("skip_paths short-circuit", () => {
	it("returns allow + summary and runs nothing else when shouldSkipPath matches (file_path)", async () => {
		mShouldSkip.mockReturnValue(true);
		const ctx = makeCtx();
		const event = ev({ tool_name: "Write", tool_input: { file_path: "dist/b.js" } });
		const decision = await runPostToolPipeline(ctx, event, makeSession());
		expect(decision.decision).toBe("allow");
		expect(decision.summary).toBe("skip_paths matched (dist/b.js) — post-event pipeline skipped");
		expect(mShouldSkip).toHaveBeenCalledWith("dist/b.js", ctx.rules);
		expect(mEvaluate).not.toHaveBeenCalled();
	});

	it("derives the path from tool_input.path when file_path is absent", async () => {
		mShouldSkip.mockReturnValue(true);
		const event = ev({ tool_name: "Write", tool_input: { path: "dist/c.js" } });
		const decision = await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(decision.summary).toContain("dist/c.js");
	});

	it("does not short-circuit when the raw path is empty (no file_path/path)", async () => {
		const event = ev({ tool_name: "Read" });
		const decision = await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(decision.summary).toBeUndefined();
		// shouldSkipPath is short-circuited away by the empty-string guard.
		expect(mShouldSkip).not.toHaveBeenCalled();
		expect(mEvaluate).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// 2. Trigram dirty-layer update
// ---------------------------------------------------------------------------

describe("trigram dirty-layer update", () => {
	function ctxWithIndex(updateFile = vi.fn()): { ctx: ServerRuntime; updateFile: Mock } {
		const fileContentCache = { set: vi.fn() };
		const ctx = makeCtx({ trigramIndex: { updateFile }, fileContentCache });
		return { ctx, updateFile: updateFile as unknown as Mock };
	}

	it("updates the index + content cache for an in-repo file write", async () => {
		const { ctx, updateFile } = ctxWithIndex();
		mExtractPaths.mockReturnValue([]);
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/src/a.ts" } });
		await runPostToolPipeline(ctx, event, makeSession());
		expect(updateFile).toHaveBeenCalledWith("src/a.ts", "file contents");
		expect((ctx.fileContentCache as unknown as { set: Mock }).set).toHaveBeenCalledWith(
			"src/a.ts",
			"file contents",
		);
	});

	it("joins a relative path against cwd before reading", async () => {
		const { ctx, updateFile } = ctxWithIndex();
		const event = ev({ tool_name: "Write", tool_input: { file_path: "src/rel.ts" } });
		await runPostToolPipeline(ctx, event, makeSession());
		expect(mReadFile).toHaveBeenCalledWith("/repo/src/rel.ts", "utf-8");
		expect(updateFile).toHaveBeenCalledWith("src/rel.ts", "file contents");
	});

	it("skips the update for a non-write tool even with trigram index present", async () => {
		const { ctx, updateFile } = ctxWithIndex();
		const event = ev({ tool_name: "Read", tool_input: { file_path: "/repo/src/a.ts" } });
		await runPostToolPipeline(ctx, event, makeSession());
		expect(updateFile).not.toHaveBeenCalled();
	});

	it("skips when the resolved file does not exist on disk", async () => {
		const { ctx, updateFile } = ctxWithIndex();
		mExistsSync.mockReturnValue(false); // affects both the dirty check and downstream marker writes
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/src/gone.ts" } });
		await runPostToolPipeline(ctx, event, makeSession());
		expect(updateFile).not.toHaveBeenCalled();
	});

	it("skips an out-of-tree write (relative path starts with ..)", async () => {
		const { ctx, updateFile } = ctxWithIndex();
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/other/x.ts" } });
		await runPostToolPipeline(ctx, event, makeSession());
		expect(updateFile).not.toHaveBeenCalled();
	});

	it("swallows a readFileSync throw inside the dirty-layer try/catch", async () => {
		const { ctx, updateFile } = ctxWithIndex();
		mReadFile.mockImplementationOnce(() => {
			throw new Error("read boom");
		});
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/src/a.ts" } });
		const decision = await runPostToolPipeline(ctx, event, makeSession());
		expect(updateFile).not.toHaveBeenCalled();
		expect(decision.decision).toBe("allow");
	});

	it("handles a write event whose file_path is empty", async () => {
		const { ctx, updateFile } = ctxWithIndex();
		const event = ev({ tool_name: "Write", tool_input: { command: "noop" } });
		await runPostToolPipeline(ctx, event, makeSession());
		expect(updateFile).not.toHaveBeenCalled();
	});

	it("falls back to an empty toolName (|| '') when tool_name is absent", async () => {
		// Exercises the `event.tool_name || ""` fallback while the trigram
		// index is present; with no tool name the write list never matches.
		const { ctx, updateFile } = ctxWithIndex();
		const event = ev({ tool_input: { file_path: "/repo/src/a.ts" } });
		await runPostToolPipeline(ctx, event, makeSession());
		expect(updateFile).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 2b. Defensive falsy-session guard (session is typed non-null, but the
// orchestrator still guards `if (session)`; a degraded caller could pass a
// falsy value).
// ---------------------------------------------------------------------------

describe("falsy-session guard", () => {
	it("skips test-run tracking + tool-response checks when session is falsy", async () => {
		mDetectTestRun.mockReturnValue("src/x.test.ts");
		mCheckSilent.mockReturnValue({ kind: "body-error" });
		const event = ev({ tool_name: "Bash", tool_input: { command: "vitest run x" } });
		const decision = await runPostToolPipeline(
			makeCtx(),
			event,
			null as unknown as SessionTrajectory,
		);
		expect(decision.decision).toBe("allow");
		// `if (session)` false → no TDD recording, no silent-failure check.
		expect(mRecordTestRunCycle).not.toHaveBeenCalled();
		expect(mCheckSilent).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 3. Test-run tracking
// ---------------------------------------------------------------------------

describe("test-run tracking", () => {
	it("records a pass + drives the TDD cycle when a test runner is detected", async () => {
		mDetectTestRun.mockReturnValue("src/x.test.ts");
		const session = makeSession();
		const event = ev({ tool_name: "Bash", tool_input: { command: "vitest run x" } });
		await runPostToolPipeline(makeCtx(), event, session);
		expect(session.test_runs.get("src/x.test.ts")).toEqual({ status: "pass", at_step: 3 });
		expect(mRecordTestRunCycle).toHaveBeenCalledWith(session, "src/x.test.ts", true);
	});

	it("records a fail for a PostToolUseFailure hook event", async () => {
		mDetectTestRun.mockReturnValue("src/x.test.ts");
		const session = makeSession();
		const event = ev({
			hook_event: "PostToolUseFailure",
			tool_name: "Bash",
			tool_input: { command: "vitest run x" },
		});
		await runPostToolPipeline(makeCtx(), event, session);
		expect(session.test_runs.get("src/x.test.ts")).toEqual({ status: "fail", at_step: 3 });
		expect(mRecordTestRunCycle).toHaveBeenCalledWith(session, "src/x.test.ts", false);
	});

	it("does nothing when no test runner is detected", async () => {
		mDetectTestRun.mockReturnValue(null);
		const session = makeSession();
		await runPostToolPipeline(makeCtx(), ev({ tool_name: "Bash" }), session);
		expect(mRecordTestRunCycle).not.toHaveBeenCalled();
		expect(session.test_runs.size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 4. Failure-recovery channels
// ---------------------------------------------------------------------------

describe("failure-recovery channels", () => {
	it("appends channel warnings when tool_outcome is error", async () => {
		mFailureChannels.mockReturnValue({ warnings: ["CHAN-1", "CHAN-2"] });
		const event = ev({ tool_name: "Bash", tool_outcome: "error" });
		const decision = await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(decision.warnings).toEqual(["CHAN-1", "CHAN-2"]);
		expect(mFailureChannels).toHaveBeenCalledOnce();
	});

	it("merges channel warnings into an existing warnings array", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", warnings: ["EXISTING"] });
		mFailureChannels.mockReturnValue({ warnings: ["CHAN"] });
		const event = ev({ tool_name: "Bash", tool_outcome: "error" });
		const decision = await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(decision.warnings).toEqual(["EXISTING", "CHAN"]);
	});

	it("does not append when the channel output has no warnings", async () => {
		mFailureChannels.mockReturnValue({ warnings: [] });
		const event = ev({ tool_name: "Bash", tool_outcome: "error" });
		const decision = await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(decision.warnings).toBeUndefined();
	});

	it("does not append when the channel output is null", async () => {
		mFailureChannels.mockReturnValue(null);
		const event = ev({ tool_name: "Bash", tool_outcome: "error" });
		const decision = await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(decision.warnings).toBeUndefined();
	});

	it("skips channels entirely when tool_outcome is not error", async () => {
		const event = ev({ tool_name: "Bash", tool_outcome: "success" });
		await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(mFailureChannels).not.toHaveBeenCalled();
	});

	it("fails open (logs, no throw) when the channel orchestrator throws an Error", async () => {
		const log = vi.fn();
		mFailureChannels.mockImplementation(() => {
			throw new Error("orchestrator boom");
		});
		const event = ev({ tool_name: "Bash", tool_outcome: "error" });
		const decision = await runPostToolPipeline(makeCtx({ log }), event, makeSession());
		expect(decision.decision).toBe("allow");
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("Failure-recovery channels error: orchestrator boom"),
		);
	});

	it("stringifies a non-Error throw from the channel orchestrator", async () => {
		const log = vi.fn();
		mFailureChannels.mockImplementation(() => {
			throw "plain string boom";
		});
		const event = ev({ tool_name: "Bash", tool_outcome: "error" });
		await runPostToolPipeline(makeCtx({ log }), event, makeSession());
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("Failure-recovery channels error: plain string boom"),
		);
	});
});

// ---------------------------------------------------------------------------
// 5. Content scanner post-scan
// ---------------------------------------------------------------------------

describe("content scanner post-scan", () => {
	function ctxWithScanner(): ServerRuntime {
		return makeCtx({
			contentScanner: {},
			rules: makeRules({ content_scanner: { enabled: true } }),
		});
	}

	it("appends post-scan warnings when scanner enabled and warnings produced", async () => {
		mPostScan.mockResolvedValue({ warnings: ["PII-RATCHET"], findings: [] });
		const event = ev({ tool_name: "Read", tool_input: { file_path: "src/a.ts" } });
		const decision = await runPostToolPipeline(ctxWithScanner(), event, makeSession());
		expect(decision.warnings).toEqual(["PII-RATCHET"]);
		expect(mPostScan).toHaveBeenCalledOnce();
	});

	it("merges post-scan warnings into an existing warnings array", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", warnings: ["PRE"] });
		mPostScan.mockResolvedValue({ warnings: ["PII"], findings: [] });
		const event = ev({ tool_name: "Read", tool_input: { file_path: "src/a.ts" } });
		const decision = await runPostToolPipeline(ctxWithScanner(), event, makeSession());
		expect(decision.warnings).toEqual(["PRE", "PII"]);
	});

	it("does not append when post-scan returns no warnings", async () => {
		mPostScan.mockResolvedValue({ warnings: [], findings: [] });
		const event = ev({ tool_name: "Read", tool_input: { file_path: "src/a.ts" } });
		const decision = await runPostToolPipeline(ctxWithScanner(), event, makeSession());
		expect(decision.warnings).toBeUndefined();
	});

	it("skips post-scan when contentScanner is absent", async () => {
		const ctx = makeCtx({ rules: makeRules({ content_scanner: { enabled: true } }) });
		await runPostToolPipeline(ctx, ev({ tool_name: "Read" }), makeSession());
		expect(mPostScan).not.toHaveBeenCalled();
	});

	it("skips post-scan when content_scanner config is disabled", async () => {
		const ctx = makeCtx({ contentScanner: {} });
		await runPostToolPipeline(ctx, ev({ tool_name: "Read" }), makeSession());
		expect(mPostScan).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 6. Tool-response checks (silent-failure / bloat / consecutive)
// ---------------------------------------------------------------------------

describe("tool-response checks", () => {
	it("pushes a silent-failure warning and records it once per tool", async () => {
		mCheckSilent.mockReturnValue({ kind: "body-error" });
		const session = makeSession();
		const event = ev({ tool_name: "mcp__x", tool_response: { ok: false } });
		const decision = await runPostToolPipeline(makeCtx(), event, session);
		expect(decision.warnings).toContain("SILENT");
		expect(session.silent_failure_warned.has("mcp__x")).toBe(true);
		expect(decision.checks_ran).toContain("silent-failure");
	});

	it("does not re-fire silent-failure when the tool is already warned", async () => {
		mCheckSilent.mockReturnValue({ kind: "body-error" });
		const session = makeSession({ silent_failure_warned: new Set(["mcp__x"]) });
		const event = ev({ tool_name: "mcp__x" });
		const decision = await runPostToolPipeline(makeCtx(), event, session);
		expect(mCheckSilent).not.toHaveBeenCalled();
		expect(decision.warnings ?? []).not.toContain("SILENT");
	});

	it("does not push silent-failure when the check returns null", async () => {
		mCheckSilent.mockReturnValue(null);
		const decision = await runPostToolPipeline(
			makeCtx(),
			ev({ tool_name: "mcp__x" }),
			makeSession(),
		);
		expect(mCheckSilent).toHaveBeenCalledOnce();
		expect(decision.warnings ?? []).not.toContain("SILENT");
	});

	it("pushes a context-bloat warning and records it once per tool", async () => {
		mCheckBloat.mockReturnValue({ tokens: 9000 });
		const session = makeSession();
		const decision = await runPostToolPipeline(makeCtx(), ev({ tool_name: "Grep" }), session);
		expect(decision.warnings).toContain("BLOAT");
		expect(session.bloat_warned.has("Grep")).toBe(true);
		expect(decision.checks_ran).toContain("context-bloat");
	});

	it("does not re-fire context-bloat when already warned", async () => {
		mCheckBloat.mockReturnValue({ tokens: 9000 });
		const session = makeSession({ bloat_warned: new Set(["Grep"]) });
		await runPostToolPipeline(makeCtx(), ev({ tool_name: "Grep" }), session);
		expect(mCheckBloat).not.toHaveBeenCalled();
	});

	it("pushes a consecutive-error warning from the existing failure counter", async () => {
		mConsecutive.mockReturnValue("CONSEC");
		const session = makeSession({
			consecutive_tool_failures: new Map([["Bash", 3]]),
		});
		const decision = await runPostToolPipeline(makeCtx(), ev({ tool_name: "Bash" }), session);
		expect(decision.warnings).toContain("CONSEC");
		expect(decision.checks_ran).toContain("consecutive-errors");
		expect(mConsecutive).toHaveBeenCalledWith(3, "Bash");
	});

	it("passes 0 to the consecutive check when no counter entry exists (|| fallback)", async () => {
		mConsecutive.mockReturnValue(null);
		await runPostToolPipeline(makeCtx(), ev({ tool_name: "Bash" }), makeSession());
		expect(mConsecutive).toHaveBeenCalledWith(0, "Bash");
	});

	it("skips all tool-response checks when tool_name is absent", async () => {
		await runPostToolPipeline(makeCtx(), ev({}), makeSession());
		expect(mCheckSilent).not.toHaveBeenCalled();
		expect(mCheckBloat).not.toHaveBeenCalled();
		expect(mConsecutive).not.toHaveBeenCalled();
	});

	it("appends silent-failure / bloat / consecutive into a pre-existing warnings array", async () => {
		// Pre-seeds postDecision.warnings so the `!postDecision.warnings`
		// guards on all three tool-response pushes take their false branch.
		mEvaluate.mockReturnValue({ decision: "allow", warnings: ["SEED"] });
		mCheckSilent.mockReturnValue({ kind: "body-error" });
		mCheckBloat.mockReturnValue({ tokens: 9000 });
		mConsecutive.mockReturnValue("CONSEC");
		const session = makeSession({ consecutive_tool_failures: new Map([["Bash", 4]]) });
		const decision = await runPostToolPipeline(makeCtx(), ev({ tool_name: "Bash" }), session);
		expect(decision.warnings).toEqual(["SEED", "SILENT", "BLOAT", "CONSEC"]);
	});
});

// ---------------------------------------------------------------------------
// 7. Edited-path resolution (direct edit / Bash detection / neither)
// ---------------------------------------------------------------------------

describe("edited-path resolution", () => {
	it("runs per-file checks for a direct file edit via extractAllEditedFilePaths", async () => {
		mExtractPaths.mockReturnValue(["/repo/a.ts", "/repo/b.ts"]);
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } });
		await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(mExtractPaths).toHaveBeenCalledWith(event);
		// One per-file call per extracted path.
		expect(mRunPerFile).toHaveBeenCalledTimes(2);
		expect(mRunPerFile.mock.calls[0]?.[3]).toBe("/repo/a.ts");
		expect(mRunPerFile.mock.calls[1]?.[3]).toBe("/repo/b.ts");
	});

	it("falls back to the empty-string single-path when a direct edit yields no paths", async () => {
		mExtractPaths.mockReturnValue([]);
		const event = ev({ tool_name: "Write", tool_input: { command: "x" } });
		await runPostToolPipeline(makeCtx(), event, makeSession());
		// shouldRunChecks is true (isDirectFileEdit) so the loop runs once with "".
		expect(mRunPerFile).toHaveBeenCalledTimes(1);
		expect(mRunPerFile.mock.calls[0]?.[3]).toBe("");
	});

	it("extracts an edited file path from a Bash command", async () => {
		const event = ev({
			tool_name: "Bash",
			tool_input: { command: "sed -i 's/a/b/' src/util.ts" },
		});
		await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(mRunPerFile).toHaveBeenCalledTimes(1);
		expect(mRunPerFile.mock.calls[0]?.[3]).toBe("src/util.ts");
	});

	it("does not run per-file checks for a Bash command touching no source file", async () => {
		const event = ev({ tool_name: "Bash", tool_input: { command: "ls -la" } });
		await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(mRunPerFile).not.toHaveBeenCalled();
	});

	it("does not run per-file checks for a non-edit, non-Bash tool", async () => {
		const event = ev({ tool_name: "WebFetch", tool_input: { url: "https://x" } });
		await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(mRunPerFile).not.toHaveBeenCalled();
	});

	it("handles a Bash event with no command string", async () => {
		const event = ev({ tool_name: "Bash" });
		await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(mRunPerFile).not.toHaveBeenCalled();
	});

	it("passes a shared accumulator across the per-file fan-out", async () => {
		mExtractPaths.mockReturnValue(["/repo/a.ts", "/repo/b.ts"]);
		let firstAcc: PerFileCheckCtx | undefined;
		let secondAcc: PerFileCheckCtx | undefined;
		mRunPerFile.mockImplementation(
			async (_ctx, _ev, _se, _path, _dec, acc: PerFileCheckCtx) => {
				if (!firstAcc) firstAcc = acc;
				else secondAcc = acc;
			},
		);
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } });
		await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(firstAcc).toBeDefined();
		expect(firstAcc).toBe(secondAcc);
		expect(firstAcc?.projectWideSweepFired).toBe(false);
		expect(firstAcc?.recurrenceCursor).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 8. Marker / pending-warnings file I/O
// ---------------------------------------------------------------------------

describe("marker and pending-warnings file I/O", () => {
	it("creates the data dir when missing then writes the in-progress marker", async () => {
		// existsSync false for both the dirty check (no index here) and the dir.
		mExistsSync.mockReturnValue(false);
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } });
		await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(mMkdir).toHaveBeenCalledWith("/repo/.interlinked", { recursive: true });
		expect(mWriteFile).toHaveBeenCalledWith(
			"/repo/.interlinked/quality-check-in-progress",
			expect.any(String),
		);
		// Marker removed at the end (unlink with no pending warnings).
		expect(mUnlink).toHaveBeenCalledWith("/repo/.interlinked/quality-check-in-progress");
	});

	it("logs but continues when the marker write throws", async () => {
		const log = vi.fn();
		mWriteFile.mockImplementationOnce(() => {
			throw new Error("marker fail");
		});
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } });
		const decision = await runPostToolPipeline(makeCtx({ log }), event, makeSession());
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("Failed to write quality-check marker"),
		);
		expect(decision.decision).toBe("allow");
	});

	it("stringifies a non-Error marker-write throw", async () => {
		const log = vi.fn();
		mWriteFile.mockImplementationOnce(() => {
			throw "marker string fail";
		});
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } });
		await runPostToolPipeline(makeCtx({ log }), event, makeSession());
		expect(log).toHaveBeenCalledWith(expect.stringContaining("marker string fail"));
	});

	it("writes pending-quality-warnings.json when warnings accumulated, then removes the marker", async () => {
		mRunPerFile.mockImplementation(
			async (_ctx, _ev, _se, _path, decision: HarnessDecision) => {
				decision.warnings = ["W1"];
			},
		);
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } });
		await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(mWriteFile).toHaveBeenCalledWith(
			"/repo/.interlinked/pending-quality-warnings.json",
			JSON.stringify(["W1"]),
		);
		expect(mUnlink).toHaveBeenCalledWith("/repo/.interlinked/quality-check-in-progress");
	});

	it("removes the marker (no pending file) when there are no warnings", async () => {
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } });
		await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(mWriteFile).not.toHaveBeenCalledWith(
			"/repo/.interlinked/pending-quality-warnings.json",
			expect.anything(),
		);
		expect(mUnlink).toHaveBeenCalledWith("/repo/.interlinked/quality-check-in-progress");
	});

	it("recovers by unlinking the marker when the pending write throws", async () => {
		const log = vi.fn();
		mRunPerFile.mockImplementation(
			async (_ctx, _ev, _se, _path, decision: HarnessDecision) => {
				decision.warnings = ["W1"];
			},
		);
		// First writeFile = marker (ok), second = pending (throws).
		mWriteFile
			.mockImplementationOnce(() => undefined)
			.mockImplementationOnce(() => {
				throw new Error("pending fail");
			});
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } });
		await runPostToolPipeline(makeCtx({ log }), event, makeSession());
		expect(log).toHaveBeenCalledWith(expect.stringContaining("Quality check file error"));
		expect(mUnlink).toHaveBeenCalledWith("/repo/.interlinked/quality-check-in-progress");
	});

	it("swallows a nested unlink failure inside the pending-write catch", async () => {
		const log = vi.fn();
		mRunPerFile.mockImplementation(
			async (_ctx, _ev, _se, _path, decision: HarnessDecision) => {
				decision.warnings = ["W1"];
			},
		);
		mWriteFile
			.mockImplementationOnce(() => undefined)
			.mockImplementationOnce(() => {
				throw new Error("pending fail");
			});
		mUnlink.mockImplementation(() => {
			throw new Error("unlink fail");
		});
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } });
		const decision = await runPostToolPipeline(makeCtx({ log }), event, makeSession());
		// Reaches the log line after the nested catch swallowed the unlink throw.
		expect(log).toHaveBeenCalledWith(expect.stringContaining("Quality check file error"));
		expect(decision.decision).toBe("allow");
	});
});

// ---------------------------------------------------------------------------
// 9. Tail aggregation: check_results / checks_ran / tool_breakdown / phases
// ---------------------------------------------------------------------------

describe("tail aggregation of structured results", () => {
	it("attaches check_results, checks_ran (deduped), timing, tool_breakdown, and phase_breakdown", async () => {
		const f = finding();
		mRunPerFile.mockImplementation(
			async (_ctx, _ev, _se, _path, _dec, acc: PerFileCheckCtx) => {
				acc.allCheckResults.push(f);
				acc.checksRan.push("structural", "structural", "typescript");
				acc.postToolMetrics.push({ tool: "tsc", ms: 12, finding_count: 1 });
			},
		);
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } });
		const decision = await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(decision.check_results).toEqual([f]);
		expect(decision.checks_ran).toEqual(["structural", "typescript"]);
		expect(typeof decision.checks_timing_ms).toBe("number");
		expect(decision.tool_breakdown).toEqual([{ tool: "tsc", ms: 12, finding_count: 1 }]);
		expect(decision.phase_breakdown).toBeDefined();
		expect(Object.keys(decision.phase_breakdown ?? {})).toEqual(
			expect.arrayContaining(["pre_tool_response", "tool_response_checks", "session_persist"]),
		);
	});

	it("omits check_results / checks_ran / tool_breakdown when nothing accumulated", async () => {
		const event = ev({ tool_name: "Read", tool_input: { file_path: "src/a.ts" } });
		const decision = await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(decision.check_results).toBeUndefined();
		expect(decision.checks_ran).toBeUndefined();
		expect(decision.checks_timing_ms).toBeUndefined();
		expect(decision.tool_breakdown).toBeUndefined();
		// phase_breakdown is always attached.
		expect(decision.phase_breakdown).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// 10. Required-tool coverage
// ---------------------------------------------------------------------------

describe("required-tool coverage", () => {
	it("warns once per missing required tool and acknowledges it", async () => {
		mGetEngine.mockReturnValue({ isToolAvailable: vi.fn(() => false) });
		const ctx = makeCtx({ rules: makeRules({ required_tools: ["tsc"] }) });
		const session = makeSession();
		const decision = await runPostToolPipeline(ctx, ev({ tool_name: "Read" }), session);
		expect(decision.warnings?.some((w) => w.includes('Required tool "tsc"'))).toBe(true);
		expect(session.acknowledged_checks.has("required-tool-missing::tsc")).toBe(true);
	});

	it("merges the required-tool warning into an existing warnings array", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", warnings: ["PRE"] });
		mGetEngine.mockReturnValue({ isToolAvailable: vi.fn(() => false) });
		const ctx = makeCtx({ rules: makeRules({ required_tools: ["tsc"] }) });
		const decision = await runPostToolPipeline(ctx, ev({ tool_name: "Read" }), makeSession());
		expect(decision.warnings?.[0]).toBe("PRE");
		expect(decision.warnings?.some((w) => w.includes('Required tool "tsc"'))).toBe(true);
	});

	it("does not warn when the required tool is available", async () => {
		mGetEngine.mockReturnValue({ isToolAvailable: vi.fn(() => true) });
		const ctx = makeCtx({ rules: makeRules({ required_tools: ["tsc"] }) });
		const decision = await runPostToolPipeline(ctx, ev({ tool_name: "Read" }), makeSession());
		expect(decision.warnings ?? []).not.toContainEqual(expect.stringContaining("Required tool"));
	});

	it("skips a required tool already acknowledged this session", async () => {
		const isToolAvailable = vi.fn(() => false);
		mGetEngine.mockReturnValue({ isToolAvailable });
		const ctx = makeCtx({ rules: makeRules({ required_tools: ["tsc"] }) });
		const session = makeSession({
			acknowledged_checks: new Set(["required-tool-missing::tsc"]),
		});
		await runPostToolPipeline(ctx, ev({ tool_name: "Read" }), session);
		expect(isToolAvailable).not.toHaveBeenCalled();
	});

	it("skips the required-tool block entirely when required_tools is empty", async () => {
		await runPostToolPipeline(makeCtx(), ev({ tool_name: "Read" }), makeSession());
		expect(mGetEngine).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 11. All-clean summary line
// ---------------------------------------------------------------------------

describe("all-clean summary line", () => {
	it("emits a positive summary mapping check names when no warnings and checks ran", async () => {
		mRunPerFile.mockImplementation(
			async (_ctx, _ev, _se, _path, _dec, acc: PerFileCheckCtx) => {
				acc.checksRan.push(
					"structural",
					"typescript",
					"biome_lint",
					"secrets_in_source",
					"affected_tests",
					"custom_check",
				);
			},
		);
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } });
		const decision = await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(decision.summary).toMatch(/^\[interlinked\] ✓ 2 guard rules, /);
		expect(decision.summary).toContain("structural");
		expect(decision.summary).toContain("tsc");
		expect(decision.summary).toContain("biome");
		expect(decision.summary).toContain("secrets");
		expect(decision.summary).toContain("tests");
		// Unmapped names: underscores → dashes.
		expect(decision.summary).toContain("custom-check");
		expect(decision.summary).toMatch(/all clean \(\d+ms\)/);
	});

	it("does not emit a summary when there are warnings", async () => {
		mRunPerFile.mockImplementation(
			async (_ctx, _ev, _se, _path, decision: HarnessDecision, acc: PerFileCheckCtx) => {
				acc.checksRan.push("typescript");
				decision.warnings = ["a finding"];
			},
		);
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } });
		const decision = await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(decision.summary).toBeUndefined();
	});

	it("does not emit a summary when no checks ran (non-edit, clean)", async () => {
		const decision = await runPostToolPipeline(
			makeCtx(),
			ev({ tool_name: "Read", tool_input: { file_path: "src/a.ts" } }),
			makeSession(),
		);
		expect(decision.summary).toBeUndefined();
	});
});
