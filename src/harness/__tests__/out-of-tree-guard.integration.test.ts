// Regression test for the out-of-tree PostToolUse guard.
//
// The harness PostToolUse handler in `server.ts` runs three project-rooted
// analysis surfaces on every Edit/Write:
//   1. the project-wide sweep (cross-file tsc/biome over CWD),
//   2. `runStructureChecks` (artifact-graph build rooted at the project),
//   3. the subprocess `command`-based quality checks (tsc/biome/gitleaks),
//      which `quality-checks.ts` runs against a resolved project root.
// All three walk the filesystem from the edited file's project. When the
// edited file is OUTSIDE the harness's own project (CWD) — e.g. a file
// under `~/.claude/...` — the project root falls back to CWD and these
// surfaces would build/refresh THIS repo's graph and run THIS repo's
// tooling for a foreign file: wrong result, and an 11-19s tree walk.
//
// The guard skips all three for out-of-tree edits (gated on
// `editedFileInRepo`), while keeping the `markPhase(...)` calls firing so a
// skipped phase records ~0ms naturally. Inline content checks still run.
//
// This test drives a real harness daemon over its unix socket (the only
// path that exercises the `processEvent` PostToolUse handler and builds
// `phase_breakdown` / `tool_breakdown`). It asserts that out-of-tree edits
// skip the project-rooted surfaces and in-tree edits still trigger them.

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HarnessDecision, HarnessEvent } from "../types.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const SERVER_ENTRY = join("src", "harness", "server.ts");

// Unique scratch root per process so parallel test files cannot collide on
// the socket path or the temp project tree.
const SCRATCH = join(tmpdir(), `interlinked-otg-${process.pid}`);
const PROJECT = join(SCRATCH, "proj"); // the harness's own project (CWD)
const OUTSIDE = join(SCRATCH, "elsewhere"); // a sibling tree, NOT under PROJECT
const FAKE_HOME = join(SCRATCH, "fake-home"); // mimics ~/.claude/...
const SOCKET = join(SCRATCH, "harness.sock");

// These budgets bound REAL subprocess work — a cold artifact-graph build over
// 250 files plus a biome run — so they are load-sensitive by nature, not
// resolution-sensitive. Measured 2026-08-05: the suite failed 4 tests here
// whenever anything else was busy (a second vitest worker, the repo's own
// harness daemon at ~566MB, a concurrent mutation run), and the file even
// flaked 1-in-2 running ALONE on a loaded box. A controlled bisect ruled out
// cross-test pollution: pairing the file with a trivial no-op test reproduced
// the failures identically, so no other test's state is involved.
//
// The budgets are generous rather than tight on purpose. This test asserts a
// SKIPPED phase costs near-zero while an in-tree edit costs real time — a
// ratio, not a deadline — so a larger ceiling weakens nothing it checks; it
// only stops a busy machine from being reported as a broken guard.
const SERVER_STARTUP_TIMEOUT_MS = 120_000;
const SEND_TIMEOUT_MS = 120_000;
// `runStructureChecks` builds the artifact graph by walking the project
// tree. A project with this many files makes the structure phase cost real,
// measurable wall time on the (cold) first in-tree edit — well above the
// near-zero a skipped phase records for an out-of-tree edit.
const PROJECT_FILE_COUNT = 250;

// --- Structure-phase skip assertion: RATIO against a same-process control ---
//
// An earlier version of this file asserted the skipped structure phase's ms
// against a fixed absolute ceiling (6ms). That is the same anti-pattern the
// MD_LINK_RE ReDoS-linearity test hit and fixed (commit 80eaf2b): an
// absolute-millisecond number says nothing about the property under test,
// only about how busy the machine happened to be. Under a loaded machine (a
// 6-agent fleet + the full suite sharing this box) the "skipped" phase — real
// cost near-zero — measured 7ms and 11ms against that 6ms ceiling and failed,
// while an isolated rerun moments later passed 7/7. The skip behavior was
// correct both times; only the load changed.
//
// The fix: measure a CONTROL in the SAME process — the real in-tree cold
// artifact-graph build's own `scored_suggestions` ms (captured by the first
// test below, which runs before the skip cases so the value exists when they
// need it) — and assert each skip case stays under a comfortable FRACTION of
// it, floored at STRUCTURE_SKIP_FLOOR_MS. Load inflates both sides together
// (both share the same event loop / CPU contention), so the ratio survives
// it; an accidental regression that makes the "skip" path actually build the
// graph would cost close to 100% of the control — far past FRACTION either
// way.
//
// Constants below are picked from measured values, not guesses: a fresh probe
// run against this exact fixture recorded an in-tree cold-build ms of 27
// (matching the 8-34ms historical range already documented above) against
// out-of-tree skip ms of 0, 0, 3 (and 0 again once the graph was warm). The
// live flake this replaces showed skip ms of 7 and 11 under load.
const STRUCTURE_SKIP_FRACTION = 0.3; // 30% of the measured control
// ~1.8x the worst skip ms seen in the live flake (11ms) — comfortably above
// load jitter, comfortably below a real cold build (8-34ms historical, 27ms
// measured here).
const STRUCTURE_SKIP_FLOOR_MS = 20;

let server: ChildProcess;

/** Resolve when the harness prints its startup banner on stderr. */
function waitForServerReady(proc: ChildProcess): Promise<void> {
	return new Promise<void>((resolvePromise, rejectPromise) => {
		const timer = setTimeout(() => {
			rejectPromise(new Error("harness did not start within timeout"));
		}, SERVER_STARTUP_TIMEOUT_MS);
		proc.stderr?.on("data", (chunk: Buffer) => {
			if (chunk.toString("utf-8").includes("Harness started")) {
				clearTimeout(timer);
				resolvePromise();
			}
		});
		proc.on("error", (err) => {
			clearTimeout(timer);
			rejectPromise(err);
		});
		proc.on("exit", (code) => {
			clearTimeout(timer);
			rejectPromise(new Error(`harness exited early (code ${code})`));
		});
	});
}

/** Send one newline-delimited event to the daemon, resolve with its decision. */
function sendEvent(event: HarnessEvent): Promise<HarnessDecision> {
	return new Promise<HarnessDecision>((resolvePromise, rejectPromise) => {
		const sock = connect(SOCKET);
		let buffer = "";
		const timer = setTimeout(() => {
			sock.destroy();
			rejectPromise(new Error("no response from harness within timeout"));
		}, SEND_TIMEOUT_MS);
		sock.on("connect", () => sock.write(`${JSON.stringify(event)}\n`));
		sock.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf-8");
			const newlineIdx = buffer.indexOf("\n");
			if (newlineIdx !== -1) {
				clearTimeout(timer);
				sock.destroy();
				try {
					resolvePromise(JSON.parse(buffer.slice(0, newlineIdx)) as HarnessDecision);
				} catch {
					rejectPromise(new Error(`unparseable harness response: ${buffer.slice(0, 200)}`));
				}
			}
		});
		sock.on("error", (err) => {
			clearTimeout(timer);
			rejectPromise(err);
		});
	});
}

/** Build a PostToolUse Edit event for a file path. */
function editEvent(filePath: string, sessionId: string): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: sessionId,
		agent_source: "claude",
		agent_name: "out-of-tree-guard-test",
		tool_name: "Edit",
		tool_input: { file_path: filePath, old_string: "1", new_string: "3" },
		timestamp: new Date(1_700_000_000_000).toISOString(),
		cwd: PROJECT,
	};
}

/** True when `phase_breakdown` carries the given phase key (regardless of ms). */
function hasPhase(decision: HarnessDecision, phase: string): boolean {
	return decision.phase_breakdown != null && phase in decision.phase_breakdown;
}

/**
 * Same-process control for the structure-phase skip assertion (see the
 * STRUCTURE_SKIP_* constants above). Populated once by the in-tree cold-build
 * test, which the describe block below runs FIRST for exactly this reason.
 */
let structureControlMs: number | undefined;

/** Record the in-tree cold-build's own `scored_suggestions` ms as the control. */
function recordStructureControl(ms: number): void {
	structureControlMs = ms;
}

/**
 * Assert a structure phase was SKIPPED (out-of-tree edit): its ms must stay
 * under a small fraction of the same-process in-tree cold-build control,
 * floored so machine-load jitter on an inherently near-zero measurement can't
 * fail the assertion. See the STRUCTURE_SKIP_* constants for why this is a
 * ratio and not an absolute ms.
 */
function expectStructurePhaseSkipped(decision: HarnessDecision): void {
	const observed = decision.phase_breakdown?.scored_suggestions ?? 0;
	if (structureControlMs === undefined) {
		throw new Error(
			"structureControlMs not captured yet — the in-tree control case must run before any skip assertion",
		);
	}
	expect(observed).toBeLessThanOrEqual(
		Math.max(STRUCTURE_SKIP_FLOOR_MS, structureControlMs * STRUCTURE_SKIP_FRACTION),
	);
}

beforeAll(async () => {
	rmSync(SCRATCH, { recursive: true, force: true });
	mkdirSync(join(PROJECT, "src", "nested"), { recursive: true });
	mkdirSync(join(PROJECT, ".interlinked"), { recursive: true });
	mkdirSync(OUTSIDE, { recursive: true });
	mkdirSync(join(FAKE_HOME, ".claude", "hooks"), { recursive: true });

	// Keep one command-based check enabled as the subprocess-surface
	// discriminator. `biome_lint` is backed by this package's npm dependency,
	// so CI and local runs don't depend on optional system binaries such as
	// gitleaks being installed.
	writeFileSync(
		join(PROJECT, ".interlinked", "guard-rules.json"),
		JSON.stringify({
			quality_checks: {
				typescript: { enabled: false },
				biome_lint: { enabled: true },
				biome_check: { enabled: false },
				semgrep: { enabled: false },
				eslint: { enabled: false },
				gitleaks: { enabled: false },
			},
		}),
	);
	writeFileSync(join(PROJECT, "biome.json"), JSON.stringify({ files: { ignoreUnknown: true } }));

	// Populate the project so the artifact-graph build (structure phase) has
	// real work to do on the first in-tree edit.
	for (let i = 0; i < PROJECT_FILE_COUNT; i++) {
		writeFileSync(
			join(PROJECT, "src", `mod${i}.ts`),
			`export const value${i}: number = ${i};\n`,
		);
	}
	// In-tree edit targets.
	writeFileSync(join(PROJECT, "src", "thing.ts"), "export const x: number = 1;\n");
	writeFileSync(join(PROJECT, "src", "nested", "deep.ts"), "export const z: number = 9;\n");
	// Out-of-tree edit targets: a sibling tree and a fake `~/.claude/...` path.
	writeFileSync(join(OUTSIDE, "foreign.ts"), "export const a: number = 1;\n");
	writeFileSync(join(FAKE_HOME, ".claude", "hooks", "hook.ts"), "export const b: number = 2;\n");

	server = spawn(
		TSX_BIN,
		[SERVER_ENTRY, "--socket", SOCKET, "--cwd", PROJECT, "--idle-timeout", "120000"],
		// `detached: true` makes the daemon its own process-group leader. tsx forks
		// the real `node server.ts` as a child, so a plain `server.kill()` in
		// afterAll only signals the launcher and ORPHANS the daemon — which then
		// lingers for the full --idle-timeout (2 min), leaking across the suite and
		// deadlocking the Linux CI run (finding 2026-06). afterAll signals the whole
		// group (negative pid) so the forked daemon dies with the launcher.
		{ cwd: REPO_ROOT, stdio: ["ignore", "ignore", "pipe"], detached: true },
	);
	await waitForServerReady(server);
}, SERVER_STARTUP_TIMEOUT_MS + 10_000);

afterAll(() => {
	// Signal the whole process group (negative pid) so the tsx-forked `node
	// server.ts` daemon dies with its launcher; fall back to a direct kill if the
	// group send fails (e.g. already reaped). A plain server.kill() left the
	// forked daemon orphaned and leaking (finding 2026-06).
	if (server?.pid !== undefined) {
		try {
			process.kill(-server.pid, "SIGKILL");
		} catch (e) {
			void e;
			try {
				server.kill("SIGKILL");
			} catch (e2) {
				void e2;
			}
		}
	}
	rmSync(SCRATCH, { recursive: true, force: true });
});

// 120s, overriding the global 30s. Without this the raised socket budgets above
// are dead letters: vitest would abort the test at 30s before the send timeout
// could fire, so the flake would persist while looking like a different bug.
// `write.test.ts` sets a 60s override for the same reason — real subprocess work
// does not fit the default.
describe("out-of-tree PostToolUse guard", { timeout: 400_000 }, () => {
	// This case runs FIRST and deliberately: it is the only in-tree edit that
	// hits a COLD artifact graph (`ctx.structureGraph` starts null), so its own
	// `scored_suggestions` ms is the real-work CONTROL the skip cases below
	// compare themselves against (see the STRUCTURE_SKIP_* constants and
	// `expectStructurePhaseSkipped`). Once this test's graph build completes,
	// later in-tree edits hit a WARM cache and cost ~1ms — no longer
	// distinguishable from a skip on timing alone, which is exactly why this
	// case must be the one to run first and why the others don't attempt a
	// timing assertion of their own.
	it("still runs subprocess + structure analysis for an in-tree edit", async () => {
		const decision = await sendEvent(
			editEvent(join(PROJECT, "src", "thing.ts"), "otg-in-abs"),
		);

		// Subprocess `command`-based check (biome_lint) ran: a per-tool breakdown
		// is present, and the `inline_biome_lint` phase mark fired.
		expect(decision.tool_breakdown).toBeDefined();
		expect(decision.tool_breakdown?.some((t) => t.tool === "biome")).toBe(true);
		expect(hasPhase(decision, "inline_biome_lint")).toBe(true);

		// The structure phase did real work — the artifact-graph build over the
		// project tree costs measurably more than a skipped (out-of-tree) phase.
		// This measurement IS the control the skip assertions below compare
		// themselves against.
		const controlMs = decision.phase_breakdown?.scored_suggestions ?? 0;
		recordStructureControl(controlMs);
		expect(controlMs).toBeGreaterThan(STRUCTURE_SKIP_FLOOR_MS);

		// Marks present here too (the in-tree path also goes through them).
		expect(hasPhase(decision, "project_wide_sweep")).toBe(true);
		expect(hasPhase(decision, "scored_suggestions")).toBe(true);
	});

	it("skips subprocess + structure analysis for an edit in a sibling tree", async () => {
		const decision = await sendEvent(
			editEvent(join(OUTSIDE, "foreign.ts"), "otg-out-sibling"),
		);

		// Subprocess `command`-based checks are skipped: no per-tool breakdown,
		// and the `inline_biome_lint` phase mark (fired only after the command
		// check actually runs) is absent.
		expect(decision.tool_breakdown ?? null).toBeNull();
		expect(hasPhase(decision, "inline_biome_lint")).toBe(false);

		// Structure phase did effectively no work — the artifact-graph build
		// was skipped, so the phase records near-zero (ratio-checked against
		// the in-tree control above; see STRUCTURE_SKIP_* for why).
		expectStructurePhaseSkipped(decision);

		// The phase marks still fire (skip the work, not the marks).
		expect(hasPhase(decision, "project_wide_sweep")).toBe(true);
		expect(hasPhase(decision, "scored_suggestions")).toBe(true);
		// The pre-gate boundary still fires for the same check — proving the
		// check was reached and then deliberately gated, not merely disabled.
		expect(hasPhase(decision, "yield_biome_lint")).toBe(true);
	});

	it("skips subprocess + structure analysis for an edit under a foreign ~/.claude path", async () => {
		const decision = await sendEvent(
			editEvent(join(FAKE_HOME, ".claude", "hooks", "hook.ts"), "otg-out-home"),
		);

		expect(decision.tool_breakdown ?? null).toBeNull();
		expect(hasPhase(decision, "inline_biome_lint")).toBe(false);
		expectStructurePhaseSkipped(decision);
		expect(hasPhase(decision, "project_wide_sweep")).toBe(true);
		expect(hasPhase(decision, "scored_suggestions")).toBe(true);
	});

	it("skips subprocess + structure analysis for a path that escapes CWD via ..", async () => {
		// `PROJECT/../escape.ts` resolves OUTSIDE PROJECT — confirms the guard
		// normalizes paths (`resolve`) rather than matching on a literal prefix.
		const escapePath = join(PROJECT, "..", "escape.ts");
		writeFileSync(escapePath, "export const c: number = 3;\n");

		const decision = await sendEvent(editEvent(escapePath, "otg-out-traversal"));

		expect(decision.tool_breakdown ?? null).toBeNull();
		expect(hasPhase(decision, "inline_biome_lint")).toBe(false);
		expectStructurePhaseSkipped(decision);
		expect(hasPhase(decision, "project_wide_sweep")).toBe(true);
		expect(hasPhase(decision, "scored_suggestions")).toBe(true);
	});

	it("still runs subprocess analysis for a nested in-tree edit", async () => {
		const decision = await sendEvent(
			editEvent(join(PROJECT, "src", "nested", "deep.ts"), "otg-in-nested"),
		);

		expect(decision.tool_breakdown).toBeDefined();
		expect(decision.tool_breakdown?.some((t) => t.tool === "biome")).toBe(true);
		expect(hasPhase(decision, "inline_biome_lint")).toBe(true);
	});

	it("still runs subprocess analysis for an in-tree edit given as a relative path", async () => {
		// A bare relative path (no leading slash) resolves within CWD — the
		// guard treats it as in-tree.
		const decision = await sendEvent(editEvent("src/thing.ts", "otg-in-relative"));

		expect(decision.tool_breakdown).toBeDefined();
		expect(decision.tool_breakdown?.some((t) => t.tool === "biome")).toBe(true);
		expect(hasPhase(decision, "inline_biome_lint")).toBe(true);
	});

	it("never crashes the PostToolUse pipeline for out-of-tree edits", async () => {
		// A correct, fast result is still returned — just without the
		// project-graph / sweep / subprocess phases.
		const decision = await sendEvent(
			editEvent(join(OUTSIDE, "foreign.ts"), "otg-out-result-shape"),
		);
		expect(decision.decision).toBe("allow");
		expect(decision.phase_breakdown).toBeDefined();
	});
});
