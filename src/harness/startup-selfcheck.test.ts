// ===========================================
// Startup self-check — a broken build must fail LOUDLY at start
// ===========================================
// Cause (1) of the 2026-08-16 restart storm: `dist` was rebuilt from a red tree
// (tsup transpiles without typechecking), so the daemon started, bound its
// socket, reported healthy — and threw on specific event paths. Every affected
// tool call read as "harness unreachable", every blocked caller asked for a
// restart, and the loop ran for hours. The build was bad from the first second
// and nothing said so. These cases pin that a throwing pipeline now exits.

import { describe, expect, it } from "vitest";
import type { DaemonLedgerEvent } from "./daemon-ledger.js";
import {
	buildSelfCheckEventLine,
	runStartupSelfCheck,
	SELF_CHECK_EXIT_CODE,
	SELF_CHECK_FAILED_REASON,
	SELF_CHECK_SESSION_ID,
	SELF_CHECK_TIMEOUT_MS,
} from "./startup-selfcheck.js";

const CWD = "/repo";

function harness() {
	const events: DaemonLedgerEvent[] = [];
	const exits: number[] = [];
	const logs: string[] = [];
	return {
		events,
		exits,
		logs,
		base: {
			cwd: CWD,
			log: (m: string) => logs.push(m),
			recordEvent: (e: DaemonLedgerEvent) => events.push(e),
			exit: (code: number) => exits.push(code),
			now: () => 1_700_000_000_000,
		},
	};
}

describe("buildSelfCheckEventLine — positive (must fire)", () => {
	it("P1: is a single parseable JSON line", () => {
		const line = buildSelfCheckEventLine(CWD, 0);
		expect(line.includes("\n")).toBe(false);
		expect(() => JSON.parse(line)).not.toThrow();
	});

	it("P2: is a PreToolUse Edit — the shape the gate pipeline actually runs", () => {
		const parsed = JSON.parse(buildSelfCheckEventLine(CWD, 0));
		expect(parsed.hook_event).toBe("PreToolUse");
		expect(parsed.tool_name).toBe("Edit");
		expect(typeof parsed.tool_input.file_path).toBe("string");
	});

	it("P3: is marked dry_run so no evaluator persists anything for it", () => {
		expect(JSON.parse(buildSelfCheckEventLine(CWD, 0)).dry_run).toBe(true);
	});

	it("P4: uses a reserved session id, so it never pollutes a real session", () => {
		expect(JSON.parse(buildSelfCheckEventLine(CWD, 0)).session_id).toBe(SELF_CHECK_SESSION_ID);
	});
});

describe("buildSelfCheckEventLine — negative (must not fire)", () => {
	it("N1: the probe content is tiny — this runs on the startup path", () => {
		expect(buildSelfCheckEventLine(CWD, 0).length).toBeLessThan(600);
	});

	it("N2: the probe path stays inside the repo's own tool-state dir", () => {
		const parsed = JSON.parse(buildSelfCheckEventLine(CWD, 0));
		expect(parsed.tool_input.file_path.startsWith(CWD)).toBe(true);
		expect(parsed.tool_input.file_path).toContain(".interlinked");
	});
});

describe("runStartupSelfCheck — positive (must fire: refuse to serve a broken build)", () => {
	it("P1: a throwing pipeline records startup-selfcheck-failed and exits non-zero", async () => {
		const h = harness();
		const ok = await runStartupSelfCheck({
			...h.base,
			evaluate: () => Promise.reject(new Error("checkMutationKillEvidence is not defined")),
		});
		expect(ok).toBe(false);
		expect(h.events).toHaveLength(1);
		expect(h.events[0]?.reason).toBe(SELF_CHECK_FAILED_REASON);
		expect(h.events[0]?.detail).toContain("checkMutationKillEvidence");
		expect(h.exits).toEqual([SELF_CHECK_EXIT_CODE]);
	});

	it("P2: a SYNCHRONOUS throw is caught too (a bad import throws on call, not await)", async () => {
		const h = harness();
		const ok = await runStartupSelfCheck({
			...h.base,
			evaluate: () => {
				throw new Error("boom");
			},
		});
		expect(ok).toBe(false);
		expect(h.exits).toEqual([SELF_CHECK_EXIT_CODE]);
	});

	it("P3: a healthy pipeline returns true, exits nothing, and writes no exit row", async () => {
		const h = harness();
		const ok = await runStartupSelfCheck({
			...h.base,
			evaluate: () => Promise.resolve({ decision: "allow" }),
		});
		expect(ok).toBe(true);
		expect(h.exits).toEqual([]);
		expect(h.events).toEqual([]);
	});
});

describe("runStartupSelfCheck — negative (must not fire: continuity beats zeal)", () => {
	it("N1: a BLOCK verdict is a working pipeline, not a broken build", async () => {
		const h = harness();
		const ok = await runStartupSelfCheck({
			...h.base,
			evaluate: () => Promise.resolve({ decision: "block", reason: "nope" }),
		});
		expect(ok).toBe(true);
		expect(h.exits).toEqual([]);
	});

	it("N2: a SLOW pipeline warns but never exits — a busy machine is not a bad build", async () => {
		const h = harness();
		const ok = await runStartupSelfCheck({
			...h.base,
			timeoutMs: SELF_CHECK_TIMEOUT_MS,
			evaluate: () => new Promise((r) => setTimeout(() => r({ decision: "allow" }), SELF_CHECK_TIMEOUT_MS * 4)),
		});
		expect(ok).toBe(true);
		expect(h.exits).toEqual([]);
		expect(h.logs.join(" ")).toContain("did not finish");
	});

	it("N3: a rejection AFTER the timeout still cannot exit a serving daemon", async () => {
		const h = harness();
		const ok = await runStartupSelfCheck({
			...h.base,
			timeoutMs: SELF_CHECK_TIMEOUT_MS,
			evaluate: () =>
				new Promise((_r, reject) => setTimeout(() => reject(new Error("late")), SELF_CHECK_TIMEOUT_MS * 3)),
		});
		expect(ok).toBe(true);
		// Poll past the late rejection rather than sleeping a guessed interval:
		// the assertion is "no exit EVER", so the deadline bounds only failure.
		const deadline = Date.now() + 500;
		while (Date.now() < deadline && h.exits.length === 0) {
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(h.exits).toEqual([]);
	});
});
