// Behavioral companion tests for lifecycle-stop-warnings.ts.
//
// Strategy: the module under test is pure orchestration — every branch is
// driven by (a) config flags on `ctx.rules`, (b) the null/string return of
// an imported formatter/detector, or (c) the presence/absence of a session
// field consumed through `??`. We `vi.mock` each imported helper module so
// every formatter outcome is controllable, then assert the module's real
// outputs (returned strings, pushed warnings, log lines, mutated session
// state). No timers, network, or fs are touched; the mocks make the suite
// fully deterministic.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mock every imported helper module ------------------------------------

vi.mock("../commit-cadence.js", () => ({
	formatStopNudge: vi.fn(),
	readSessionTokens: vi.fn(),
}));
vi.mock("../dead-on-arrival.js", () => ({
	detectDeadOnArrival: vi.fn(),
	formatDeadOnArrivalWarning: vi.fn(),
}));
vi.mock("../fixture-leak.js", () => ({
	detectFixtureLeaks: vi.fn(),
	formatFixtureLeakWarning: vi.fn(),
}));
vi.mock("../verification-stop-checks.js", () => ({
	countCodeFilesEdited: vi.fn(),
	countDocFactSourcesEdited: vi.fn(),
	countUiFilesEdited: vi.fn(),
	formatBisectNotResetWarning: vi.fn(),
	formatDocMarkerDriftWarning: vi.fn(),
	formatStubsIntroducedWarning: vi.fn(),
	formatTddRegressionWarning: vi.fn(),
	formatUiNotInteractedWarning: vi.fn(),
	formatUnresolvedRedWarning: vi.fn(),
	formatUnverifiedCodeWarning: vi.fn(),
	formatVerifyNotRunWarning: vi.fn(),
}));

import { formatStopNudge, readSessionTokens } from "../commit-cadence.js";
import {
	detectDeadOnArrival,
	formatDeadOnArrivalWarning,
} from "../dead-on-arrival.js";
import { detectFixtureLeaks, formatFixtureLeakWarning } from "../fixture-leak.js";
import type { HarnessEvent, SessionTrajectory } from "../types.js";
import {
	countCodeFilesEdited,
	countDocFactSourcesEdited,
	countUiFilesEdited,
	formatBisectNotResetWarning,
	formatDocMarkerDriftWarning,
	formatStubsIntroducedWarning,
	formatTddRegressionWarning,
	formatUiNotInteractedWarning,
	formatUnresolvedRedWarning,
	formatUnverifiedCodeWarning,
	formatVerifyNotRunWarning,
} from "../verification-stop-checks.js";
import {
	buildCommitCadenceNudge,
	buildVerificationStopWarnings,
	pushIfNotNull,
} from "./lifecycle-stop-warnings.js";
import type { ServerRuntime } from "./runtime-context.js";

// Typed handles to the mocked functions.
const mFormatStopNudge = vi.mocked(formatStopNudge);
const mReadSessionTokens = vi.mocked(readSessionTokens);
const mDetectDeadOnArrival = vi.mocked(detectDeadOnArrival);
const mFormatDeadOnArrivalWarning = vi.mocked(formatDeadOnArrivalWarning);
const mDetectFixtureLeaks = vi.mocked(detectFixtureLeaks);
const mFormatFixtureLeakWarning = vi.mocked(formatFixtureLeakWarning);
const mCountCodeFilesEdited = vi.mocked(countCodeFilesEdited);
const mCountDocFactSourcesEdited = vi.mocked(countDocFactSourcesEdited);
const mCountUiFilesEdited = vi.mocked(countUiFilesEdited);
const mFormatBisectNotResetWarning = vi.mocked(formatBisectNotResetWarning);
const mFormatDocMarkerDriftWarning = vi.mocked(formatDocMarkerDriftWarning);
const mFormatStubsIntroducedWarning = vi.mocked(formatStubsIntroducedWarning);
const mFormatTddRegressionWarning = vi.mocked(formatTddRegressionWarning);
const mFormatUnresolvedRedWarning = vi.mocked(formatUnresolvedRedWarning);
const mFormatUiNotInteractedWarning = vi.mocked(formatUiNotInteractedWarning);
const mFormatUnverifiedCodeWarning = vi.mocked(formatUnverifiedCodeWarning);
const mFormatVerifyNotRunWarning = vi.mocked(formatVerifyNotRunWarning);

// ---- Fixtures --------------------------------------------------------------

const logLines: string[] = [];

function makeCtx(over: Record<string, unknown> = {}): ServerRuntime {
	const base = {
		cwd: "/repo",
		rules: {},
		log: (msg: string) => {
			logLines.push(msg);
		},
		logAlways: () => {},
	};
	return { ...base, ...over } as unknown as ServerRuntime;
}

function makeEvent(over: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "Stop",
		session_id: "s1",
		agent_source: "claude",
		timestamp: "2026-06-05T00:00:00.000Z",
		...over,
	};
}

/** Minimal SessionTrajectory carrying only the fields the module reads. The
 *  cast lets us omit the ~40 unrelated fields. */
function makeSession(over: Record<string, unknown> = {}): SessionTrajectory {
	const base = {
		stop_nudge_emitted: false,
		non_doc_files_edited_since_commit: new Set<string>(),
		doc_files_edited_since_commit: 0,
		verification_observed: new Set<string>(),
		stubs_introduced: [],
		tdd_cycles: new Map(),
		commands_run: [],
		files_written: new Set<string>(),
	};
	return { ...base, ...over } as unknown as SessionTrajectory;
}

beforeEach(() => {
	logLines.length = 0;
	vi.clearAllMocks();
	// Safe defaults: every formatter returns null (no warning) and every
	// detector returns an empty array unless a test overrides it. This makes
	// each branch test isolate a single firing path.
	mFormatStopNudge.mockReturnValue(null);
	mReadSessionTokens.mockReturnValue(null);
	mDetectDeadOnArrival.mockReturnValue([]);
	mFormatDeadOnArrivalWarning.mockReturnValue(null);
	mDetectFixtureLeaks.mockReturnValue([]);
	mFormatFixtureLeakWarning.mockReturnValue(null);
	mCountCodeFilesEdited.mockReturnValue(0);
	mCountDocFactSourcesEdited.mockReturnValue(0);
	mCountUiFilesEdited.mockReturnValue(0);
	mFormatBisectNotResetWarning.mockReturnValue(null);
	mFormatDocMarkerDriftWarning.mockReturnValue(null);
	mFormatStubsIntroducedWarning.mockReturnValue(null);
	mFormatTddRegressionWarning.mockReturnValue(null);
	mFormatUnresolvedRedWarning.mockReturnValue(null);
	mFormatUiNotInteractedWarning.mockReturnValue(null);
	mFormatUnverifiedCodeWarning.mockReturnValue(null);
	mFormatVerifyNotRunWarning.mockReturnValue(null);
});

// ===========================================================================
// pushIfNotNull
// ===========================================================================
describe("pushIfNotNull", () => {
	it("pushes a non-null string", () => {
		const arr: string[] = [];
		pushIfNotNull(arr, "x");
		expect(arr).toEqual(["x"]);
	});

	it("pushes an empty string (only null is excluded)", () => {
		const arr: string[] = [];
		pushIfNotNull(arr, "");
		expect(arr).toEqual([""]);
	});

	it("does not push null", () => {
		const arr: string[] = ["existing"];
		pushIfNotNull(arr, null);
		expect(arr).toEqual(["existing"]);
	});
});

// ===========================================================================
// buildCommitCadenceNudge
// ===========================================================================
describe("buildCommitCadenceNudge", () => {
	it("returns null when commit_cadence config is absent (cadenceCfg?.enabled undefined)", () => {
		const ctx = makeCtx({ rules: {} });
		expect(buildCommitCadenceNudge(ctx, makeEvent(), makeSession())).toBeNull();
		expect(mFormatStopNudge).not.toHaveBeenCalled();
	});

	it("returns null when commit_cadence.enabled is false", () => {
		const ctx = makeCtx({ rules: { commit_cadence: { enabled: false } } });
		expect(buildCommitCadenceNudge(ctx, makeEvent(), makeSession())).toBeNull();
	});

	it("returns null when session is falsy", () => {
		const ctx = makeCtx({ rules: { commit_cadence: { enabled: true } } });
		// session arg null exercises the `!session` short-circuit.
		expect(
			buildCommitCadenceNudge(ctx, makeEvent(), null as unknown as SessionTrajectory),
		).toBeNull();
	});

	it("returns null when the nudge was already emitted this session", () => {
		const ctx = makeCtx({ rules: { commit_cadence: { enabled: true } } });
		const session = makeSession({ stop_nudge_emitted: true });
		expect(buildCommitCadenceNudge(ctx, makeEvent(), session)).toBeNull();
		expect(mFormatStopNudge).not.toHaveBeenCalled();
	});

	it("returns null (without mutating state) when formatStopNudge returns null", () => {
		const ctx = makeCtx({
			rules: {
				commit_cadence: {
					enabled: true,
					stop_threshold: 5,
					token_band_low: 10,
					token_band_high: 20,
				},
			},
		});
		const session = makeSession();
		mFormatStopNudge.mockReturnValue(null);
		expect(buildCommitCadenceNudge(ctx, makeEvent(), session)).toBeNull();
		expect(session.stop_nudge_emitted).toBe(false);
		expect(logLines).toHaveLength(0);
	});

	it("returns the nudge, marks stop_nudge_emitted, and logs on success", () => {
		const ctx = makeCtx({
			rules: {
				commit_cadence: {
					enabled: true,
					stop_threshold: 3,
					token_band_low: 100,
					token_band_high: 200,
				},
			},
		});
		const session = makeSession({
			non_doc_files_edited_since_commit: new Set(["a.ts", "b.ts"]),
			doc_files_edited_since_commit: 4,
		});
		mReadSessionTokens.mockReturnValue({ total: 1234 } as ReturnType<
			typeof readSessionTokens
		>);
		mFormatStopNudge.mockReturnValue("NUDGE-TEXT");

		const result = buildCommitCadenceNudge(ctx, makeEvent(), session);

		expect(result).toBe("NUDGE-TEXT");
		expect(session.stop_nudge_emitted).toBe(true);
		// The cumulative-tokens-defined branch passes cumulativeTokens through.
		expect(mFormatStopNudge).toHaveBeenCalledWith({
			uncommittedNonDocCount: 2,
			docFilesExcluded: 4,
			threshold: 3,
			cumulativeTokens: 1234,
			tokenBandLow: 100,
			tokenBandHigh: 200,
		});
		expect(logLines[0]).toContain("Commit-cadence Stop nudge: 2 uncommitted code files");
		expect(logLines[0]).toContain("4 doc files excluded");
		expect(logLines[0]).toContain("tokens=1234");
	});

	it("omits cumulativeTokens when readSessionTokens returns null and logs tokens=n/a", () => {
		const ctx = makeCtx({
			rules: {
				commit_cadence: {
					enabled: true,
					stop_threshold: 0,
					token_band_low: 1,
					token_band_high: 2,
				},
			},
		});
		const session = makeSession();
		mReadSessionTokens.mockReturnValue(null);
		mFormatStopNudge.mockReturnValue("N");

		buildCommitCadenceNudge(ctx, makeEvent(), session);

		// The spread `...(cumulativeTokens !== undefined ? {...} : {})` must omit
		// the key entirely when tokens are absent.
		const arg = mFormatStopNudge.mock.calls[0]?.[0];
		expect(arg).toBeDefined();
		expect(Object.hasOwn(arg as object, "cumulativeTokens")).toBe(false);
		expect(logLines[0]).toContain("tokens=n/a");
	});

	it("treats a tokens object without a total as undefined cumulativeTokens", () => {
		const ctx = makeCtx({
			rules: {
				commit_cadence: {
					enabled: true,
					stop_threshold: 0,
					token_band_low: 1,
					token_band_high: 2,
				},
			},
		});
		const session = makeSession();
		// tokens defined but .total undefined -> cumulativeTokens === undefined.
		mReadSessionTokens.mockReturnValue({ total: undefined } as unknown as ReturnType<
			typeof readSessionTokens
		>);
		mFormatStopNudge.mockReturnValue("N");

		buildCommitCadenceNudge(ctx, makeEvent(), session);

		const arg = mFormatStopNudge.mock.calls[0]?.[0];
		expect(Object.hasOwn(arg as object, "cumulativeTokens")).toBe(false);
		// `tokens?.total ?? "n/a"` -> total is undefined -> "n/a".
		expect(logLines[0]).toContain("tokens=n/a");
	});

	it("defaults counts to 0 when the session count fields are absent (?? fallbacks)", () => {
		const ctx = makeCtx({
			rules: {
				commit_cadence: {
					enabled: true,
					stop_threshold: 0,
					token_band_low: 1,
					token_band_high: 2,
				},
			},
		});
		// Omit non_doc_files_edited_since_commit and doc_files_edited_since_commit.
		const session = makeSession({
			non_doc_files_edited_since_commit: undefined,
			doc_files_edited_since_commit: undefined,
		});
		mFormatStopNudge.mockReturnValue("N");

		buildCommitCadenceNudge(ctx, makeEvent(), session);

		expect(mFormatStopNudge).toHaveBeenCalledWith(
			expect.objectContaining({ uncommittedNonDocCount: 0, docFilesExcluded: 0 }),
		);
	});
});

// ===========================================================================
// buildVerificationStopWarnings
// ===========================================================================
describe("buildVerificationStopWarnings", () => {
	function vscRules(over: Record<string, unknown> = {}) {
		return {
			verification_stop_checks: {
				enabled: true,
				warn_unverified_code: false,
				warn_verify_not_run: false,
				warn_ui_not_interacted: false,
				warn_stubs_introduced: false,
				warn_fixture_leaks: false,
				warn_unresolved_red: false,
				...over,
			},
		};
	}

	it("returns [] when verification_stop_checks config is absent", () => {
		const ctx = makeCtx({ rules: {} });
		expect(buildVerificationStopWarnings(ctx, makeEvent(), makeSession())).toEqual([]);
	});

	it("returns [] when verification_stop_checks.enabled is false", () => {
		const ctx = makeCtx({ rules: { verification_stop_checks: { enabled: false } } });
		expect(buildVerificationStopWarnings(ctx, makeEvent(), makeSession())).toEqual([]);
	});

	it("returns [] when session is falsy", () => {
		const ctx = makeCtx({ rules: vscRules() });
		expect(
			buildVerificationStopWarnings(
				ctx,
				makeEvent(),
				null as unknown as SessionTrajectory,
			),
		).toEqual([]);
	});

	it("returns [] when all flag-gated checks are off and the always-on checks find nothing", () => {
		const ctx = makeCtx({ rules: vscRules() });
		expect(buildVerificationStopWarnings(ctx, makeEvent(), makeSession())).toEqual([]);
		// Flag-gated formatters must NOT be invoked when their flag is false.
		expect(mFormatUnverifiedCodeWarning).not.toHaveBeenCalled();
		expect(mFormatVerifyNotRunWarning).not.toHaveBeenCalled();
		expect(mFormatUiNotInteractedWarning).not.toHaveBeenCalled();
		expect(mFormatStubsIntroducedWarning).not.toHaveBeenCalled();
		expect(mFormatFixtureLeakWarning).not.toHaveBeenCalled();
		// warn_unresolved_red defaults off in vscRules → its formatter must not run.
		expect(mFormatUnresolvedRedWarning).not.toHaveBeenCalled();
		// Always-on checks still run.
		expect(mFormatTddRegressionWarning).toHaveBeenCalled();
		expect(mFormatBisectNotResetWarning).toHaveBeenCalled();
		expect(mFormatDeadOnArrivalWarning).toHaveBeenCalled();
		expect(mFormatDocMarkerDriftWarning).toHaveBeenCalled();
	});

	it("defaults verification_observed to an empty Set when the session field is absent", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_unverified_code: true }) });
		const session = makeSession({ verification_observed: undefined });
		mCountCodeFilesEdited.mockReturnValue(2);
		mFormatUnverifiedCodeWarning.mockReturnValue(null);

		buildVerificationStopWarnings(ctx, makeEvent(), session);

		const arg = mFormatUnverifiedCodeWarning.mock.calls[0]?.[0];
		expect(arg?.verificationObserved).toBeInstanceOf(Set);
		expect(arg?.verificationObserved.size).toBe(0);
	});

	// --- individual flag-gated checks fire when their formatter returns text ---

	it("includes the unverified-code warning when its flag is on and formatter fires (+logs)", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_unverified_code: true }) });
		const session = makeSession({ verification_observed: new Set(["tsc"]) });
		mCountCodeFilesEdited.mockReturnValue(3);
		mFormatUnverifiedCodeWarning.mockReturnValue("UNVERIFIED");

		const out = buildVerificationStopWarnings(ctx, makeEvent(), session);

		expect(out).toContain("UNVERIFIED");
		expect(mFormatUnverifiedCodeWarning).toHaveBeenCalledWith({
			codeFilesEdited: 3,
			verificationObserved: session.verification_observed,
		});
		expect(logLines.some((l) => l.includes("unverified-code (3 files, signals=tsc)"))).toBe(
			true,
		);
	});

	it("includes the verify-not-run warning when its flag is on and formatter fires", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_verify_not_run: true }) });
		const session = makeSession();
		mCountCodeFilesEdited.mockReturnValue(1);
		mFormatVerifyNotRunWarning.mockReturnValue("VERIFY-NOT-RUN");

		const out = buildVerificationStopWarnings(ctx, makeEvent(), session);

		expect(out).toContain("VERIFY-NOT-RUN");
		// signals=none branch of the log join (empty Set -> "" -> "none").
		expect(logLines.some((l) => l.includes("verify-suite-not-run") && l.includes("signals=none"))).toBe(true);
	});

	it("includes the ui-not-interacted warning when its flag is on and formatter fires (+logs)", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_ui_not_interacted: true }) });
		const session = makeSession();
		mCountUiFilesEdited.mockReturnValue(2);
		mFormatUiNotInteractedWarning.mockReturnValue("UI-NOT-INTERACTED");

		const out = buildVerificationStopWarnings(ctx, makeEvent(), session);

		expect(out).toContain("UI-NOT-INTERACTED");
		expect(mFormatUiNotInteractedWarning).toHaveBeenCalledWith({
			uiFilesEdited: 2,
			verificationObserved: session.verification_observed,
		});
		expect(logLines.some((l) => l.includes("ui-not-interacted (2 files)"))).toBe(true);
	});

	it("does not include / log ui-not-interacted when its formatter returns null", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_ui_not_interacted: true }) });
		mCountUiFilesEdited.mockReturnValue(5);
		mFormatUiNotInteractedWarning.mockReturnValue(null);

		const out = buildVerificationStopWarnings(ctx, makeEvent(), makeSession());

		expect(out).toEqual([]);
		expect(logLines.some((l) => l.includes("ui-not-interacted"))).toBe(false);
	});

	it("includes the stubs-introduced warning when its flag is on and formatter fires (+logs)", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_stubs_introduced: true }) });
		const session = makeSession({ stubs_introduced: [{ x: 1 }, { x: 2 }] });
		mFormatStubsIntroducedWarning.mockReturnValue("STUBS");

		const out = buildVerificationStopWarnings(ctx, makeEvent(), session);

		expect(out).toContain("STUBS");
		expect(mFormatStubsIntroducedWarning).toHaveBeenCalledWith({
			stubs: session.stubs_introduced,
		});
		expect(logLines.some((l) => l.includes("stubs-introduced (2)"))).toBe(true);
	});

	it("defaults stubs to [] when stubs_introduced is absent", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_stubs_introduced: true }) });
		const session = makeSession({ stubs_introduced: undefined });
		mFormatStubsIntroducedWarning.mockReturnValue(null);

		buildVerificationStopWarnings(ctx, makeEvent(), session);

		expect(mFormatStubsIntroducedWarning).toHaveBeenCalledWith({ stubs: [] });
	});

	it("includes the fixture-leak warning when its flag is on and formatter fires (+logs)", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_fixture_leaks: true }) });
		mDetectFixtureLeaks.mockReturnValue([{ a: 1 }, { b: 2 }, { c: 3 }] as never);
		mFormatFixtureLeakWarning.mockReturnValue("FIXTURE-LEAK");

		const out = buildVerificationStopWarnings(
			ctx,
			makeEvent({ cwd: "/event-cwd" }),
			makeSession(),
		);

		expect(out).toContain("FIXTURE-LEAK");
		// event.cwd is preferred over ctx.cwd.
		expect(mDetectFixtureLeaks).toHaveBeenCalledWith("/event-cwd");
		expect(logLines.some((l) => l.includes("fixture-leaks (3)"))).toBe(true);
	});

	it("falls back to ctx.cwd for fixture leaks when event.cwd is absent", () => {
		const ctx = makeCtx({ cwd: "/ctx-cwd", rules: vscRules({ warn_fixture_leaks: true }) });
		mFormatFixtureLeakWarning.mockReturnValue(null);

		buildVerificationStopWarnings(ctx, makeEvent({}), makeSession());

		expect(mDetectFixtureLeaks).toHaveBeenCalledWith("/ctx-cwd");
	});

	// --- always-on checks ---

	it("includes the tdd-regression warning, counting only regression-state cycles (+logs)", () => {
		const ctx = makeCtx({ rules: vscRules() });
		const tdd = new Map<string, unknown>([
			["a", { state: "regression", source_file: "/a.ts" }],
			["b", { state: "green", source_file: "/b.ts" }],
			["c", { state: "regression", source_file: "/c.ts" }],
		]);
		const session = makeSession({ tdd_cycles: tdd });
		mFormatTddRegressionWarning.mockReturnValue("TDD-REGRESSION");

		const out = buildVerificationStopWarnings(ctx, makeEvent(), session);

		expect(out).toContain("TDD-REGRESSION");
		// Only the two regression cycles are forwarded.
		expect(mFormatTddRegressionWarning).toHaveBeenCalledWith({
			regressions: [{ sourceFile: "/a.ts" }, { sourceFile: "/c.ts" }],
		});
		expect(logLines.some((l) => l.includes("tdd-regression (2)"))).toBe(true);
	});

	it("forwards an empty regressions list when no cycle is in regression state", () => {
		const ctx = makeCtx({ rules: vscRules() });
		const tdd = new Map<string, unknown>([["b", { state: "green", source_file: "/b.ts" }]]);
		mFormatTddRegressionWarning.mockReturnValue(null);

		buildVerificationStopWarnings(ctx, makeEvent(), makeSession({ tdd_cycles: tdd }));

		expect(mFormatTddRegressionWarning).toHaveBeenCalledWith({ regressions: [] });
		expect(logLines.some((l) => l.includes("tdd-regression"))).toBe(false);
	});

	it("includes the bisect-not-reset warning when its formatter fires (+logs)", () => {
		const ctx = makeCtx({ rules: vscRules() });
		const session = makeSession({ commands_run: ["git bisect start"] });
		mFormatBisectNotResetWarning.mockReturnValue("BISECT");

		const out = buildVerificationStopWarnings(ctx, makeEvent(), session);

		expect(out).toContain("BISECT");
		expect(mFormatBisectNotResetWarning).toHaveBeenCalledWith({
			commandsRun: session.commands_run,
		});
		expect(logLines.some((l) => l.includes("bisect-not-reset"))).toBe(true);
	});

	it("includes the dead-on-arrival warning, preferring event.cwd (+logs)", () => {
		const ctx = makeCtx({ cwd: "/ctx", rules: vscRules() });
		const session = makeSession({ files_written: new Set(["/x.ts"]) });
		mDetectDeadOnArrival.mockReturnValue([{ file: "/x.ts" }, { file: "/y.ts" }] as never);
		mFormatDeadOnArrivalWarning.mockReturnValue("DOA");

		const out = buildVerificationStopWarnings(ctx, makeEvent({ cwd: "/ev" }), session);

		expect(out).toContain("DOA");
		expect(mDetectDeadOnArrival).toHaveBeenCalledWith(session.files_written, "/ev");
		expect(mFormatDeadOnArrivalWarning).toHaveBeenCalledWith(
			[{ file: "/x.ts" }, { file: "/y.ts" }],
			"/ev",
		);
		expect(logLines.some((l) => l.includes("dead-on-arrival (2)"))).toBe(true);
	});

	it("falls back to ctx.cwd for dead-on-arrival when event.cwd is absent", () => {
		const ctx = makeCtx({ cwd: "/ctx-doa", rules: vscRules() });
		mFormatDeadOnArrivalWarning.mockReturnValue(null);

		buildVerificationStopWarnings(ctx, makeEvent({}), makeSession());

		expect(mDetectDeadOnArrival).toHaveBeenCalledWith(expect.any(Set), "/ctx-doa");
	});

	it("includes the doc-marker-drift warning when its formatter fires (+logs)", () => {
		const ctx = makeCtx({ rules: vscRules() });
		const session = makeSession({ commands_run: ["docs:build"] });
		mCountDocFactSourcesEdited.mockReturnValue(4);
		mFormatDocMarkerDriftWarning.mockReturnValue("DOC-DRIFT");

		const out = buildVerificationStopWarnings(ctx, makeEvent(), session);

		expect(out).toContain("DOC-DRIFT");
		expect(mFormatDocMarkerDriftWarning).toHaveBeenCalledWith({
			docSourcesEdited: 4,
			commandsRun: session.commands_run,
		});
		expect(logLines.some((l) => l.includes("doc-marker-drift (4 source files)"))).toBe(true);
	});

	it("aggregates every warning in registration order when all checks fire", () => {
		const ctx = makeCtx({
			rules: vscRules({
				warn_unverified_code: true,
				warn_verify_not_run: true,
				warn_ui_not_interacted: true,
				warn_stubs_introduced: true,
				warn_fixture_leaks: true,
			}),
		});
		const session = makeSession({
			verification_observed: new Set(["lint"]),
			stubs_introduced: [{ x: 1 }],
			tdd_cycles: new Map([["a", { state: "regression", source_file: "/a.ts" }]]),
			files_written: new Set(["/f.ts"]),
		});
		mCountCodeFilesEdited.mockReturnValue(1);
		mCountUiFilesEdited.mockReturnValue(1);
		mCountDocFactSourcesEdited.mockReturnValue(1);
		mDetectFixtureLeaks.mockReturnValue([{ a: 1 }] as never);
		mDetectDeadOnArrival.mockReturnValue([{ f: 1 }] as never);
		mFormatUnverifiedCodeWarning.mockReturnValue("W1");
		mFormatVerifyNotRunWarning.mockReturnValue("W2");
		mFormatUiNotInteractedWarning.mockReturnValue("W3");
		mFormatStubsIntroducedWarning.mockReturnValue("W4");
		mFormatFixtureLeakWarning.mockReturnValue("W5");
		mFormatTddRegressionWarning.mockReturnValue("W6");
		mFormatBisectNotResetWarning.mockReturnValue("W7");
		mFormatDeadOnArrivalWarning.mockReturnValue("W8");
		mFormatDocMarkerDriftWarning.mockReturnValue("W9");

		const out = buildVerificationStopWarnings(ctx, makeEvent(), session);

		// Order matches the pushIfNotNull call sequence in the source.
		// warn_unresolved_red is off (vscRules default) so it's absent here.
		expect(out).toEqual(["W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9"]);
	});

	// --- warn_unresolved_red gated wrapper (checkUnresolvedRed) -------------

	it("does not invoke the unresolved-red formatter when the flag is off", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_unresolved_red: false }) });
		const session = makeSession({
			observed_checks: new Map([["typecheck", { kind: "typecheck", status: "red" }]]),
		});
		const out = buildVerificationStopWarnings(ctx, makeEvent(), session);
		expect(mFormatUnresolvedRedWarning).not.toHaveBeenCalled();
		expect(out).toEqual([]);
	});

	it("forwards a red observed-check (kind + detail) when the flag is on (+logs)", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_unresolved_red: true }) });
		const session = makeSession({
			observed_checks: new Map([
				["typecheck", { kind: "typecheck", status: "red", detail: "tsc --noEmit" }],
				["lint", { kind: "lint", status: "green" }],
			]),
		});
		mFormatUnresolvedRedWarning.mockReturnValue("UNRESOLVED-RED");

		const out = buildVerificationStopWarnings(ctx, makeEvent(), session);

		expect(out).toContain("UNRESOLVED-RED");
		// Only the red check is forwarded; the green one is filtered out.
		expect(mFormatUnresolvedRedWarning).toHaveBeenCalledWith({
			redChecks: [{ kind: "typecheck", detail: "tsc --noEmit" }],
			redTests: [],
		});
		expect(logLines.some((l) => l.includes("unresolved-red (1 checks, 0 tests)"))).toBe(true);
	});

	it("forwards a stayed-red TDD cycle but EXCLUDES regression-state cycles", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_unresolved_red: true }) });
		const tdd = new Map<string, unknown>([
			// stayed-red: state red, never went green → forwarded.
			["a", { state: "red", source_file: "/a.ts", red_at: 5 }],
			// regression (green→red): owned by checkTddRegression → excluded.
			["b", { state: "regression", source_file: "/b.ts", red_at: 7, green_at: 3 }],
		]);
		mFormatUnresolvedRedWarning.mockReturnValue("UNRESOLVED-RED");

		buildVerificationStopWarnings(ctx, makeEvent(), makeSession({ tdd_cycles: tdd }));

		expect(mFormatUnresolvedRedWarning).toHaveBeenCalledWith({
			redChecks: [],
			redTests: [{ sourceFile: "/a.ts" }],
		});
	});

	it("EXCLUDES a red cycle whose red was later cleared by a green (green_at >= red_at)", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_unresolved_red: true }) });
		const tdd = new Map<string, unknown>([
			// red_at 4 then green_at 9 cleared it — must NOT be forwarded.
			["a", { state: "red", source_file: "/a.ts", red_at: 4, green_at: 9 }],
		]);
		mFormatUnresolvedRedWarning.mockReturnValue(null);

		buildVerificationStopWarnings(ctx, makeEvent(), makeSession({ tdd_cycles: tdd }));

		expect(mFormatUnresolvedRedWarning).toHaveBeenCalledWith({ redChecks: [], redTests: [] });
	});

	it("does not push / log when the unresolved-red formatter returns null", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_unresolved_red: true }) });
		mFormatUnresolvedRedWarning.mockReturnValue(null);

		const out = buildVerificationStopWarnings(ctx, makeEvent(), makeSession());

		expect(out).toEqual([]);
		expect(logLines.some((l) => l.includes("unresolved-red"))).toBe(false);
	});

	it("tolerates an absent observed_checks map (defaults to empty)", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_unresolved_red: true }) });
		const session = makeSession({ observed_checks: undefined });
		mFormatUnresolvedRedWarning.mockReturnValue(null);

		buildVerificationStopWarnings(ctx, makeEvent(), session);

		expect(mFormatUnresolvedRedWarning).toHaveBeenCalledWith({ redChecks: [], redTests: [] });
	});
});
