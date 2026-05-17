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

const SERVER_STARTUP_TIMEOUT_MS = 20_000;
const SEND_TIMEOUT_MS = 15_000;
// `runStructureChecks` builds the artifact graph by walking the project
// tree. A project with this many files makes the structure phase cost real,
// measurable wall time on the (cold) first in-tree edit — well above the
// near-zero a skipped phase records for an out-of-tree edit.
const PROJECT_FILE_COUNT = 250;
// A skipped structure phase records single-digit ms (graph build never
// runs). The cold in-tree build is reliably an order of magnitude above
// this. The ceiling keeps a comfortable margin from observed values
// (out-of-tree: 0-3ms; in-tree cold: 8-34ms across runs).
const SKIPPED_STRUCTURE_PHASE_CEILING_MS = 6;

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
		{ cwd: REPO_ROOT, stdio: ["ignore", "ignore", "pipe"] },
	);
	await waitForServerReady(server);
}, SERVER_STARTUP_TIMEOUT_MS + 10_000);

afterAll(() => {
	if (server && !server.killed) server.kill("SIGKILL");
	rmSync(SCRATCH, { recursive: true, force: true });
});

describe("out-of-tree PostToolUse guard", () => {
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
		// was skipped, so the phase records near-zero.
		expect(decision.phase_breakdown?.scored_suggestions ?? 0).toBeLessThanOrEqual(
			SKIPPED_STRUCTURE_PHASE_CEILING_MS,
		);

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
		expect(decision.phase_breakdown?.scored_suggestions ?? 0).toBeLessThanOrEqual(
			SKIPPED_STRUCTURE_PHASE_CEILING_MS,
		);
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
		expect(decision.phase_breakdown?.scored_suggestions ?? 0).toBeLessThanOrEqual(
			SKIPPED_STRUCTURE_PHASE_CEILING_MS,
		);
		expect(hasPhase(decision, "project_wide_sweep")).toBe(true);
		expect(hasPhase(decision, "scored_suggestions")).toBe(true);
	});

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
		expect(decision.phase_breakdown?.scored_suggestions ?? 0).toBeGreaterThan(
			SKIPPED_STRUCTURE_PHASE_CEILING_MS,
		);

		// Marks present here too (the in-tree path also goes through them).
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
